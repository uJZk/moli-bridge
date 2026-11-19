using System.Net;
using FlareSolverrSharp;
using FlareSolverrSharp.Exceptions;

if (args.Length is < 2 or > 3)
    throw new ArgumentException("Usage: JackettSharpContract <bridge URL> <fixture URL> [expect-empty|expect-invalid|expect-unhandled|expect-datadome|expect-datadome-timeout]");

var target = new Uri(args[1]);
var jar = new CookieContainer();
using var inner = new HttpClientHandler { CookieContainer = jar, AllowAutoRedirect = false, UseProxy = false };
using var clearance = new ClearanceHandler(args[0]) { MaxTimeout = 15000, InnerHandler = inner };
if (args.Length == 3 && args[2] == "expect-datadome-timeout") clearance.MaxTimeout = 2500;
using var client = new HttpClient(clearance) { Timeout = TimeSpan.FromSeconds(25) };
using var request = new HttpRequestMessage(HttpMethod.Get, target);
request.Headers.UserAgent.ParseAdd("Jackett-fixture/1.0");
if (args.Length == 3 && args[2] == "expect-unhandled")
{
    using var unhandled = await client.SendAsync(request);
    var unhandledBody = await unhandled.Content.ReadAsStringAsync();
    if (unhandled.StatusCode != HttpStatusCode.Forbidden || !unhandledBody.Contains("DataDome fixture"))
        throw new InvalidOperationException($"Unexpected unhandled response: {(int)unhandled.StatusCode} {unhandledBody}");
    Console.WriteLine("PASS Jackett FlareSolverrSharp leaves DataDome-only response unhandled");
    return;
}
if (args.Length == 3 && args[2] != "expect-datadome")
{
    var expected = args[2] switch
    {
        "expect-empty" => "Empty cookies returned by FlareSolverr",
        "expect-invalid" => "The cookies provided by FlareSolverr are not valid",
        "expect-datadome-timeout" => "timeout",
        _ => throw new ArgumentException("Unknown expected failure"),
    };
    try
    {
        using var ignored = await client.SendAsync(request);
        throw new InvalidOperationException("Expected a clearance error");
    }
    catch (FlareSolverrException error) when (error.Message.Contains(expected, StringComparison.OrdinalIgnoreCase))
    {
        Console.WriteLine($"PASS Jackett FlareSolverrSharp {args[2]} failure");
        return;
    }
}
using var response = await client.SendAsync(request);
var body = await response.Content.ReadAsStringAsync();
if (response.StatusCode != HttpStatusCode.OK || !body.Contains("jackett retry reached"))
    throw new InvalidOperationException($"Unexpected target response: {(int)response.StatusCode} {body}");
var cookieName = args.Length == 3 && args[2] == "expect-datadome" ? "datadome" : "cf_clearance";
if (jar.GetCookies(target)[cookieName]?.Value != "fixture-clearance")
    throw new InvalidOperationException("FlareSolverrSharp did not retain the clearance cookie");
if (cookieName == "datadome" && (!response.Headers.TryGetValues("Set-Cookie", out var cookies) ||
    !cookies.Any(value => value.Contains("datadome=fixture-clearance", StringComparison.Ordinal))))
    throw new InvalidOperationException("DataDome clearance cookie was not exposed in the response");
if (!response.Headers.TryGetValues("X-Fixture-UA", out var values) ||
    !values.Single().StartsWith("Mozilla/", StringComparison.Ordinal))
    throw new InvalidOperationException("The retried request did not use Moli's user agent");
Console.WriteLine($"PASS Jackett FlareSolverrSharp {cookieName} cookie and UA handoff");
