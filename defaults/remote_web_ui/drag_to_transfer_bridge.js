(function () {
  "use strict";

  const FILE_TAB_LABELS = ["文件传输", "文件上传", "File Transfer", "File Upload"];
  const TAB_COUNT = 5;
  const HANDOFF_RETRY_MS = 120;
  const MAX_HANDOFF_ATTEMPTS = 40;

  let switchedInCurrentDrag = false;
  let pendingDropPayload = null;
  let handoffAttempts = 0;
  let handoffTimer = null;

  function normalizeText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function emitDebug(stage, payload) {
    try {
      window.fetch("/api/debug/ingest-log", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          stage,
          ...(payload || {}),
        }),
      });
    } catch (_err) {}
  }

  function hasFilePayload(event) {
    const dt = event && event.dataTransfer;
    if (!dt) return false;
    if (dt.files && dt.files.length > 0) return true;
    if (!dt.types) return false;
    try {
      return Array.from(dt.types).includes("Files");
    } catch (_err) {
      return false;
    }
  }

  function textContainsAny(text, labels) {
    return labels.some((label) => text.includes(label));
  }

  function fireClickSequence(target, clientX, clientY) {
    if (!(target instanceof Element)) return false;
    const common = {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX,
      clientY,
      button: 0,
    };
    try {
      target.dispatchEvent(new PointerEvent("pointerdown", common));
      target.dispatchEvent(new MouseEvent("mousedown", common));
      target.dispatchEvent(new PointerEvent("pointerup", common));
      target.dispatchEvent(new MouseEvent("mouseup", common));
      target.dispatchEvent(new MouseEvent("click", common));
      return true;
    } catch (_err) {
      try {
        target.dispatchEvent(new MouseEvent("click", common));
        return true;
      } catch (_err2) {
        return false;
      }
    }
  }

  function clickTransferTabByText() {
    const nodes = document.querySelectorAll("button,[role='tab'],div,span");
    for (const node of nodes) {
      if (!(node instanceof HTMLElement)) continue;
      const text = normalizeText(node.innerText || node.textContent);
      if (!text) continue;
      if (!textContainsAny(text, FILE_TAB_LABELS)) continue;
      const rect = node.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      if (fireClickSequence(node, x, y)) return true;
    }
    return false;
  }

  function computeTabBarRect() {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const width = Math.max(320, Math.min(vw - 24, Math.round(vw * 0.82)));
    const left = Math.max(12, Math.round((vw - width) / 2));
    const top = Math.max(40, Math.min(126, Math.round(vh * 0.085)));
    const height = Math.max(40, Math.min(70, Math.round(vh * 0.065)));
    return { left, width, top, height };
  }

  function clickTransferTabByHitTest() {
    const rect = computeTabBarRect();
    const slotWidth = rect.width / TAB_COUNT;
    const x = Math.round(rect.left + slotWidth * 0.5);
    const y = Math.round(rect.top + rect.height * 0.5);
    const target = document.elementFromPoint(x, y) || document.body;
    return fireClickSequence(target, x, y);
  }

  function switchToTransferTab() {
    if (clickTransferTabByText()) return true;
    return clickTransferTabByHitTest();
  }

  function mapFilesForFlutterQueue(files) {
    const mapped = [];
    for (const file of Array.from(files || [])) {
      if (!(file instanceof File)) continue;
      mapped.push({
        b: file.name || "",
        name: file.name || "",
        c: file,
        bytes: file,
        d: String(file.webkitRelativePath || ""),
        e: Number(file.size || 0),
        type: String(file.type || ""),
      });
    }
    return mapped;
  }

  function clearPendingHandoff() {
    if (handoffTimer !== null) {
      window.clearTimeout(handoffTimer);
      handoffTimer = null;
    }
    handoffAttempts = 0;
    pendingDropPayload = null;
  }

  function scheduleHandoff(reason) {
    if (!pendingDropPayload || pendingDropPayload.length === 0) return;
    if (handoffAttempts >= MAX_HANDOFF_ATTEMPTS) {
      emitDebug("bridge_handoff_timeout", {
        reason: reason || "",
        pending_count: pendingDropPayload.length,
      });
      clearPendingHandoff();
      return;
    }
    if (handoffTimer !== null) {
      window.clearTimeout(handoffTimer);
      handoffTimer = null;
    }
    handoffTimer = window.setTimeout(() => {
      handoffTimer = null;
      attemptDeferredHandoff(reason || "retry");
    }, HANDOFF_RETRY_MS);
  }

  function attemptDeferredHandoff(reason) {
    if (!pendingDropPayload || pendingDropPayload.length === 0) return;

    const enqueue = window.__friendeck_enqueue_files;
    if (typeof enqueue !== "function") {
      handoffAttempts += 1;
      emitDebug("bridge_handoff_wait", {
        attempt: handoffAttempts,
        reason: reason || "",
      });
      scheduleHandoff(reason || "wait_enqueue");
      return;
    }

    const payload = pendingDropPayload.slice();
    emitDebug("bridge_handoff_try", {
      attempt: handoffAttempts + 1,
      reason: reason || "",
      count: payload.length,
      transfer_ready: !!window.__friendeck_transfer_ready,
    });

    let result;
    try {
      result = enqueue(payload);
    } catch (err) {
      handoffAttempts += 1;
      emitDebug("bridge_handoff_throw", {
        attempt: handoffAttempts,
        msg: String(err),
      });
      scheduleHandoff("enqueue_throw");
      return;
    }

    Promise.resolve(result)
      .then((added) => {
        const normalized = Number(added);
        emitDebug("bridge_handoff_ok", {
          added: Number.isFinite(normalized) ? normalized : String(added),
          count: payload.length,
        });
        if (Number.isFinite(normalized) && normalized <= 0 && handoffAttempts < MAX_HANDOFF_ATTEMPTS - 1) {
          handoffAttempts += 1;
          scheduleHandoff("added_zero_retry");
          return;
        }
        clearPendingHandoff();
      })
      .catch((err) => {
        handoffAttempts += 1;
        emitDebug("bridge_handoff_reject", {
          attempt: handoffAttempts,
          msg: String(err),
        });
        scheduleHandoff("enqueue_reject");
      });
  }

  function queueDroppedFiles(event) {
    const dt = event && event.dataTransfer;
    if (!dt || !dt.files) return 0;
    const mapped = mapFilesForFlutterQueue(dt.files);
    if (mapped.length === 0) return 0;
    pendingDropPayload = mapped;
    handoffAttempts = 0;
    emitDebug("bridge_drop_capture", {
      count: mapped.length,
    });
    return mapped.length;
  }

  function handleDragEnter(event) {
    if (!hasFilePayload(event)) return;
    event.preventDefault();
    if (!switchedInCurrentDrag) {
      switchedInCurrentDrag = switchToTransferTab();
    }
  }

  function handleDragOver(event) {
    if (!hasFilePayload(event)) return;
    event.preventDefault();
    if (!switchedInCurrentDrag) {
      switchedInCurrentDrag = switchToTransferTab();
    }
  }

  function handleDrop(event) {
    if (!hasFilePayload(event)) return;
    // Prevent browser default "open file" navigation while keeping
    // downstream drop listeners active.
    event.preventDefault();
    queueDroppedFiles(event);
    switchToTransferTab();
    attemptDeferredHandoff("drop");
    scheduleHandoff("drop_retry");
    switchedInCurrentDrag = false;
  }

  function handleDragEnd(event) {
    if (!hasFilePayload(event)) return;
    switchedInCurrentDrag = false;
  }

  function init() {
    window.addEventListener("dragenter", handleDragEnter, true);
    window.addEventListener("dragover", handleDragOver, true);
    window.addEventListener("drop", handleDrop, true);
    window.addEventListener("dragend", handleDragEnd, true);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
