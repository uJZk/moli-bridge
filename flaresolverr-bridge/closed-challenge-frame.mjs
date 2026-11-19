// Moli's CDP DOM tree can expose closed shadow roots. Only click a checkbox
// within an identified challenge frame after confirming the hit target.
import { isChallengeFrame } from './upstream/trawl-turnstile-frame.mjs';
import { isNavigationError } from './navigation-error.mjs';

function attributes(node) {
  const result = new Map();
  const values = node.attributes ?? [];
  for (let i = 0; i + 1 < values.length; i += 2) result.set(values[i].toLowerCase(), values[i + 1]);
  return result;
}

function closedCheckboxes(document) {
  const found = [];
  const pending = [{ node: document, closed: false }];
  let visited = 0;
  while (pending.length && visited++ < 10000) {
    const { node, closed } = pending.pop();
    if (!node || typeof node !== 'object') continue;
    const withinClosed = closed || node.shadowRootType === 'closed';
    if (withinClosed && Number.isSafeInteger(node.backendNodeId)) {
      const attrs = attributes(node);
      const native = node.nodeName === 'INPUT' && (attrs.get('type') ?? '').toLowerCase() === 'checkbox';
      const aria = node.nodeName !== 'INPUT' && (attrs.get('role') ?? '').trim().toLowerCase() === 'checkbox';
      if (native || aria) found.push({ backendNodeId: node.backendNodeId, aria });
    }
    for (const child of node.children ?? []) pending.push({ node: child, closed: withinClosed });
    for (const shadow of node.shadowRoots ?? []) pending.push({ node: shadow, closed: withinClosed });
    // Nested frame documents are intentionally excluded.
  }
  return found;
}

function challengeFrames(tree, pageUrl) {
  const found = [];
  const pending = [...(tree.childFrames ?? [])];
  let visited = 0;
  while (pending.length && visited++ < 10000) {
    const item = pending.pop();
    const frame = item?.frame;
    if (frame?.id && frame.url && isChallengeFrame(frame.url, pageUrl)) found.push(frame);
    for (const child of item?.childFrames ?? []) pending.push(child);
  }
  return found;
}

async function describeFrameDocument(session, frameId) {
  const { executionContextId } = await session.send('Page.createIsolatedWorld', {
    frameId, worldName: '__moli_bridge_challenge',
  });
  const evaluated = await session.send('Runtime.evaluate', { expression: 'document', contextId: executionContextId });
  const objectId = evaluated.result?.objectId;
  if (!objectId) return undefined;
  try {
    const { node } = await session.send('DOM.describeNode', { objectId, depth: 12, pierce: true });
    return { node, executionContextId };
  } finally {
    await session.send('Runtime.releaseObject', { objectId }).catch(() => {});
  }
}

async function uncheckedCheckbox(session, backendNodeId, executionContextId) {
  let objectId;
  try {
    const { object } = await session.send('DOM.resolveNode', { backendNodeId, executionContextId });
    objectId = object?.objectId;
    if (!objectId) return false;
    const result = await session.send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: `function() {
        if (this.isConnected !== true || this.getAttribute('aria-disabled')?.toLowerCase() === 'true' ||
            this.getAttribute('aria-readonly')?.toLowerCase() === 'true') return false;
        if (this.tagName === 'INPUT') return this.type === 'checkbox' && this.checked === false && this.disabled === false && !this.matches(':disabled');
        return this.getAttribute('role')?.trim().toLowerCase() === 'checkbox' &&
          this.getAttribute('aria-checked')?.toLowerCase() === 'false' && !this.hasAttribute('disabled');
      }`,
      returnByValue: true,
    });
    return !result.exceptionDetails && result.result?.value === true;
  } catch {
    return false;
  } finally {
    if (objectId) await session.send('Runtime.releaseObject', { objectId }).catch(() => {});
  }
}

async function safeAriaDescendant(session, backendNodeId, hitNodeId, executionContextId) {
  const objects = [];
  try {
    for (const id of [backendNodeId, hitNodeId]) {
      const { object } = await session.send('DOM.resolveNode', { backendNodeId: id, executionContextId });
      if (!object?.objectId) return false;
      objects.push(object.objectId);
    }
    const result = await session.send('Runtime.callFunctionOn', {
      objectId: objects[0], arguments: [{ objectId: objects[1] }], returnByValue: true,
      functionDeclaration: `function(target) {
        let node = target.nodeType === 1 ? target : target.parentElement;
        while (node && node !== this) {
          if (node.nodeType === 1) {
            const tag = node.tagName.toLowerCase();
            const role = (node.getAttribute('role') || '').trim().toLowerCase();
            if (['a','button','input','textarea','select','iframe','label','summary'].includes(tag) ||
                ['button','link','checkbox','switch','menuitem','tab','textbox'].includes(role) ||
                node.hasAttribute('tabindex') ||
                (node.hasAttribute('contenteditable') && node.getAttribute('contenteditable') !== 'false')) return false;
          }
          node = node.parentNode;
        }
        return node === this;
      }`,
    });
    return !result.exceptionDetails && result.result?.value === true;
  } catch {
    return false;
  } finally {
    for (const objectId of objects) await session.send('Runtime.releaseObject', { objectId }).catch(() => {});
  }
}

export async function clickClosedChallengeFrame(page, isCurrent = () => true) {
  if (!isCurrent()) return false;
  const frames = page.frames();
  if (!frames.length) return false;
  const pageUrl = page.url();
  if (!frames.some(frame => isChallengeFrame(frame.url(), pageUrl))) return false;
  let session;
  try {
    session = await page.context().newCDPSession(page);
    const { frameTree } = await session.send('Page.getFrameTree');
    let foundControl = false;
    for (const frame of challengeFrames(frameTree, pageUrl)) {
      const live = () => isCurrent() && page.url() === pageUrl && page.frames().some(item => item.url() === frame.url);
      if (!live()) return false;
      let document;
      try { document = await describeFrameDocument(session, frame.id); }
      catch (error) {
        if (!live()) return false;
        if (isNavigationError(error)) throw error;
        if (/protocol error|not supported|method not found|frame was detached/i.test(error?.message ?? '')) continue;
        throw error;
      }
      if (!live()) return false;
      if (!document || document.node?.documentURL !== frame.url) continue;
      for (const { backendNodeId, aria } of closedCheckboxes(document.node)) {
        foundControl = true;
        if (!live()) return false;
        if (!await uncheckedCheckbox(session, backendNodeId, document.executionContextId)) continue;
        if (!live()) return false;
        let model;
        try { ({ model } = await session.send('DOM.getBoxModel', { backendNodeId })); }
        catch { continue; }
        const quad = model?.border;
        if (!Array.isArray(quad) || quad.length !== 8 || quad.some(value => !Number.isFinite(value))) continue;
        const x = Math.round((quad[0] + quad[2] + quad[4] + quad[6]) / 4);
        const y = Math.round((quad[1] + quad[3] + quad[5] + quad[7]) / 4);
        if (!live()) return false;
        let hit;
        try { hit = await session.send('DOM.getNodeForLocation', { x, y, includeUserAgentShadowDOM: true }); }
        catch { continue; }
        if (!live()) return false;
        if (hit.frameId !== frame.id) continue;
        if (hit.backendNodeId !== backendNodeId && (!aria || !await safeAriaDescendant(session, backendNodeId, hit.backendNodeId, document.executionContextId))) continue;
        if (!await uncheckedCheckbox(session, backendNodeId, document.executionContextId)) continue;
        if (!live()) return false;
        await page.mouse.click(x, y);
        return true;
      }
    }
    return foundControl;
  } catch (error) {
    if (!isCurrent()) return false;
    if (isNavigationError(error)) throw error;
    // Unsupported or unavailable DOM inspection is a best-effort fallback.
    if (/protocol error|not supported|method not found|frame was detached/i.test(error?.message ?? '')) return false;
    throw error;
  } finally {
    await session?.detach().catch(() => {});
  }
}
