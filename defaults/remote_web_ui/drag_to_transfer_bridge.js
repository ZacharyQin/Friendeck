(function () {
  "use strict";

  const FILE_TAB_LABELS = ["文件传输", "文件上传", "File Transfer", "File Upload"];
  const FILE_MANAGER_TAB_LABELS = ["文件管理", "File Manager"];
  const TAB_COUNT = 5;
  const HANDOFF_RETRY_MS = 120;
  const MAX_HANDOFF_ATTEMPTS = 40;
  const SCRIPT_REV = "file-manager-drop-confirm-v1";
  const TOAST_ID = "fd-bridge-toast";
  const TOAST_MS = 3200;

  let switchedInCurrentDrag = false;
  let pendingDropPayload = null;
  let handoffAttempts = 0;
  let handoffTimer = null;

  function normalizeText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function isZh() {
    const lang = String((navigator && navigator.language) || "").toLowerCase();
    return lang.startsWith("zh");
  }

  function showToast(message) {
    if (!message) return;
    const existing = document.getElementById(TOAST_ID);
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing);

    const toast = document.createElement("div");
    toast.id = TOAST_ID;
    toast.textContent = String(message);
    toast.style.position = "fixed";
    toast.style.left = "50%";
    toast.style.bottom = "24px";
    toast.style.transform = "translateX(-50%)";
    toast.style.maxWidth = "min(88vw, 680px)";
    toast.style.padding = "10px 14px";
    toast.style.borderRadius = "10px";
    toast.style.background = "rgba(20, 24, 30, 0.96)";
    toast.style.color = "#f5f7fa";
    toast.style.fontSize = "13px";
    toast.style.lineHeight = "1.35";
    toast.style.zIndex = "2147483647";
    toast.style.boxShadow = "0 8px 20px rgba(0,0,0,0.35)";
    toast.style.pointerEvents = "none";

    const host = document.body || document.documentElement;
    if (!host) return;
    host.appendChild(toast);
    window.setTimeout(() => {
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    }, TOAST_MS);
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

  function normalizeDropStats(stats) {
    const source = stats || {};
    return {
      item_count: Number(source.itemCount || 0),
      raw_file_count: Number(source.rawFileCount || 0),
      entry_candidate_count: Number(source.entryCandidateCount || 0),
      entry_directory_count: Number(source.entryDirectoryCount || 0),
      entry_file_count: Number(source.entryFileCount || 0),
      handle_candidate_count: Number(source.handleCandidateCount || 0),
      handle_directory_count: Number(source.handleDirectoryCount || 0),
      handle_file_count: Number(source.handleFileCount || 0),
      fallback_file_count: Number(source.fallbackFileCount || 0),
      directory_hint: !!source.directoryHint,
    };
  }

  function normalizeRelativePath(rawPath) {
    let path = String(rawPath || "").replace(/\\/g, "/").trim();
    if (!path) return "";
    path = path.replace(/^\/+/, "");
    if (!path) return "";
    const segments = [];
    for (const segment of path.split("/")) {
      const value = String(segment || "").trim();
      if (!value || value === ".") continue;
      if (value === "..") return "";
      segments.push(value);
    }
    return segments.join("/");
  }

  function assignRelativePath(file, rawPath) {
    if (!(file instanceof File)) return "";
    const normalized = normalizeRelativePath(rawPath);
    if (!normalized) return "";
    try {
      file._relativePath = normalized;
    } catch (_err) {}
    return normalized;
  }

  function hasFilePayload(event) {
    const dt = event && event.dataTransfer;
    if (!dt) return false;
    if (dt.files && dt.files.length > 0) return true;
    if (dt.items && dt.items.length > 0) {
      try {
        if (Array.from(dt.items).some((item) => item && item.kind === "file")) return true;
      } catch (_err) {}
    }
    if (!dt.types) return false;
    try {
      const types = Array.from(dt.types).map((type) => String(type || "").toLowerCase());
      if (types.includes("files")) return true;
      return types.some((type) => type.includes("file"));
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

  function isFileManagerTabByGlobalState() {
    try {
      if (window.__friendeck_is_file_manager_tab_active === true) return true;
      if (window.__friendeck_is_file_manager_tab_active === false) return false;
      if (typeof window.__friendeck_active_tab_index === "number") {
        return Number(window.__friendeck_active_tab_index) === 1;
      }
    } catch (_err) {}
    return null;
  }

  function isFileManagerTabByDomState() {
    try {
      const activeNodes = document.querySelectorAll(
        "[role='tab'][aria-selected='true'],button[aria-selected='true'],[aria-current='page']",
      );
      for (const node of activeNodes) {
        if (!(node instanceof HTMLElement)) continue;
        const text = normalizeText(node.innerText || node.textContent);
        if (!text) continue;
        if (textContainsAny(text, FILE_MANAGER_TAB_LABELS)) return true;
      }
    } catch (_err) {}
    return false;
  }

  function isFileManagerTabActive() {
    const fromGlobal = isFileManagerTabByGlobalState();
    if (fromGlobal !== null) return fromGlobal;
    return isFileManagerTabByDomState();
  }

  function getFileManagerCurrentPath() {
    try {
      const getter = window.__friendeck_file_manager_get_current_path;
      if (typeof getter !== "function") return "";
      return String(getter() || "").trim();
    } catch (_err) {
      return "";
    }
  }

  function buildFileManagerDropConfirmMessage(destPath, count) {
    const normalizedPath = String(destPath || "").trim();
    const itemCount = Number(count || 0);
    if (isZh()) {
      const prefix = itemCount > 1 ? `是否将这 ${itemCount} 个项目` : "是否将该文件传输";
      return `${prefix}至 ${normalizedPath}？`;
    }
    const prefix = itemCount > 1 ? `Transfer these ${itemCount} items` : "Transfer this file";
    return `${prefix} to ${normalizedPath}?`;
  }

  function getUploadFileFromMapped(item) {
    if (!item || typeof item !== "object") return null;
    const file = item.c || item.bytes || item.file || null;
    if (!file) return null;
    if (file instanceof Blob) return file;
    return null;
  }

  function getUploadName(item, file, relativePath) {
    const rel = normalizeRelativePath(relativePath);
    if (rel) return rel;
    const preferredName = String(item.name || item.b || item.filename || "").trim();
    if (preferredName) return preferredName;
    const fileName = String((file && file.name) || "").trim();
    if (fileName) return fileName;
    return "upload.bin";
  }

  async function uploadMappedFilesToDirectory(mapped, destPath) {
    const destination = String(destPath || "").trim();
    let uploaded = 0;
    const files = Array.from(mapped || []);
    for (const item of files) {
      const file = getUploadFileFromMapped(item);
      if (!(file instanceof Blob)) continue;
      const relativePath = normalizeRelativePath(item.d || item.relativePath || item.path || "");
      const uploadName = getUploadName(item, file, relativePath);
      const form = new FormData();
      form.append("dest_path", destination);
      if (relativePath) form.append("relative_path", relativePath);
      form.append("file", file, uploadName);
      const response = await window.fetch("/upload", {
        method: "POST",
        body: form,
        credentials: "same-origin",
      });
      if (!response || !response.ok) {
        const status = response && typeof response.status === "number" ? response.status : -1;
        throw new Error(`upload_failed_${status}`);
      }
      uploaded += 1;
    }
    return uploaded;
  }

  function refreshFileManagerCurrentDirectory() {
    try {
      const refresh = window.__friendeck_file_manager_refresh_current_dir;
      if (typeof refresh !== "function") return false;
      refresh();
      return true;
    } catch (_err) {
      return false;
    }
  }

  function readAllEntries(reader) {
    return new Promise((resolve) => {
      const entries = [];
      const readBatch = () => {
        reader.readEntries(
          (batch) => {
            if (!batch || batch.length === 0) {
              resolve(entries);
              return;
            }
            entries.push(...batch);
            readBatch();
          },
          () => resolve(entries),
        );
      };
      readBatch();
    });
  }

  async function walkEntry(entry, pathPrefix) {
    if (!entry) return [];
    if (entry.isFile) {
      return new Promise((resolve) => {
        entry.file(
          (file) => {
            if (!(file instanceof File)) {
              resolve([]);
              return;
            }
            let relativePath = assignRelativePath(file, `${pathPrefix}${file.name || ""}`);
            if (!relativePath && file.webkitRelativePath) {
              relativePath = assignRelativePath(file, file.webkitRelativePath);
            }
            if (!relativePath && entry.fullPath) {
              relativePath = assignRelativePath(file, entry.fullPath);
            }
            resolve([file]);
          },
          () => resolve([]),
        );
      });
    }

    if (entry.isDirectory) {
      let children = [];
      try {
        children = await readAllEntries(entry.createReader());
      } catch (_err) {
        return [];
      }
      const files = [];
      for (const child of children) {
        const nested = await walkEntry(child, `${pathPrefix}${entry.name}/`);
        files.push(...nested);
      }
      return files;
    }

    return [];
  }

  async function walkHandle(handle, pathPrefix) {
    if (!handle) return [];
    const kind = String(handle.kind || "");
    if (kind === "file") {
      try {
        const file = await handle.getFile();
        if (!(file instanceof File)) return [];
        assignRelativePath(file, `${pathPrefix}${file.name || handle.name || ""}`);
        return [file];
      } catch (_err) {
        return [];
      }
    }

    if (kind === "directory") {
      const files = [];
      const nextPrefix = `${pathPrefix}${handle.name || ""}/`;
      try {
        if (typeof handle.values === "function") {
          for await (const child of handle.values()) {
            const nested = await walkHandle(child, nextPrefix);
            files.push(...nested);
          }
          return files;
        }

        if (typeof handle.entries === "function") {
          for await (const pair of handle.entries()) {
            const child = pair && pair[1];
            const nested = await walkHandle(child, nextPrefix);
            files.push(...nested);
          }
          return files;
        }
      } catch (_err) {
        return [];
      }
    }

    return [];
  }

  async function collectDroppedFiles(dt) {
    const items = dt && dt.items ? Array.from(dt.items) : [];
    const fallbackFiles = Array.from((dt && dt.files) || []);
    const stats = {
      itemCount: items.length,
      rawFileCount: fallbackFiles.length,
      entryCandidateCount: 0,
      entryDirectoryCount: 0,
      entryFileCount: 0,
      handleCandidateCount: 0,
      handleDirectoryCount: 0,
      handleFileCount: 0,
      fallbackFileCount: fallbackFiles.length,
      directoryHint: false,
    };

    const entries = items
      .map((item) => {
        try {
          return item && typeof item.webkitGetAsEntry === "function" ? item.webkitGetAsEntry() : null;
        } catch (_err) {
          return null;
        }
      })
      .filter(Boolean);
    stats.entryCandidateCount = entries.length;
    stats.entryDirectoryCount = entries.filter((entry) => entry && entry.isDirectory).length;
    if (stats.entryDirectoryCount > 0) stats.directoryHint = true;

    if (entries.length > 0) {
      const files = [];
      for (const entry of entries) {
        const nested = await walkEntry(entry, "");
        files.push(...nested);
      }
      stats.entryFileCount = files.length;
      if (files.length > 0) {
        return {
          files,
          mode: "entries",
          stats,
        };
      }
    }

    const handleItems = items.filter((item) => item && typeof item.getAsFileSystemHandle === "function");
    stats.handleCandidateCount = handleItems.length;
    if (handleItems.length > 0) {
      const handles = [];
      for (const item of handleItems) {
        try {
          const handle = await item.getAsFileSystemHandle();
          if (handle) handles.push(handle);
        } catch (_err) {}
      }
      stats.handleDirectoryCount = handles.filter((handle) => String(handle && handle.kind) === "directory").length;
      if (stats.handleDirectoryCount > 0) stats.directoryHint = true;

      if (handles.length > 0) {
        const files = [];
        for (const handle of handles) {
          const nested = await walkHandle(handle, "");
          files.push(...nested);
        }
        stats.handleFileCount = files.length;
        if (files.length > 0) {
          return {
            files,
            mode: "handles",
            stats,
          };
        }
      }
    }

    if (stats.directoryHint === false && items.length > 0 && fallbackFiles.length === 0) {
      // Some browsers expose folder drags as items but provide no file list.
      stats.directoryHint = true;
    }

    if (fallbackFiles.length > 0) {
      return {
        files: fallbackFiles,
        mode: "files",
        stats,
      };
    }

    return {
      files: [],
      mode: "none",
      stats,
    };
  }

  function mapFilesForFlutterQueue(files) {
    const mapped = [];
    for (const file of Array.from(files || [])) {
      if (!(file instanceof File)) continue;
      const relativePath = normalizeRelativePath(file._relativePath || file.webkitRelativePath || "");
      const displayName = relativePath || file.name || "";
      mapped.push({
        b: displayName,
        name: file.name || "",
        relativePath,
        path: relativePath,
        c: file,
        bytes: file,
        d: relativePath,
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

  async function queueDroppedFiles(event) {
    const dt = event && event.dataTransfer;
    if (!dt) return { count: 0, dropped: null, reason: "no_data_transfer" };

    // Reset previous drop handoff state before collecting a new payload.
    clearPendingHandoff();
    const dropped = await collectDroppedFiles(dt);
    let mapped = mapFilesForFlutterQueue(dropped.files);
    const normalizedStats = normalizeDropStats(dropped.stats);
    const relativePathCountBefore = mapped.filter((item) => String(item && item.d || "").length > 0).length;
    const relativePathMissingBefore = Math.max(0, mapped.length - relativePathCountBefore);
    if (normalizedStats.directory_hint && mapped.length > 0) {
      if (relativePathCountBefore === 0) {
        emitDebug("bridge_drop_missing_relative_path", {
          reason: "directory_intent_pathless",
          count: mapped.length,
          relative_path_count: 0,
          relative_path_missing_count: relativePathMissingBefore,
          collect_mode: dropped.mode,
          ...normalizedStats,
        });
        return { count: 0, dropped, reason: "directory_missing_relative_path" };
      }
      if (relativePathMissingBefore > 0) {
        mapped = mapped.filter((item) => String(item && item.d || "").length > 0);
        emitDebug("bridge_drop_partial_relative_path", {
          reason: "directory_partial_pathless_filtered",
          count: mapped.length,
          dropped_count: relativePathMissingBefore,
          relative_path_count: mapped.length,
          relative_path_missing_count: 0,
          collect_mode: dropped.mode,
          ...normalizedStats,
        });
      }
    }
    if (mapped.length === 0) {
      return { count: 0, dropped, reason: "expanded_empty" };
    }

    pendingDropPayload = mapped;
    handoffAttempts = 0;
    const relativePathCount = mapped.filter((item) => String(item && item.d || "").length > 0).length;
    const relativePathMissingCount = Math.max(0, mapped.length - relativePathCount);
    emitDebug("bridge_drop_capture", {
      count: mapped.length,
      collect_mode: dropped.mode,
      expanded_count: dropped.files.length,
      relative_path_count: relativePathCount,
      relative_path_missing_count: relativePathMissingCount,
      ...normalizedStats,
    });
    return { count: mapped.length, dropped, reason: "ok" };
  }

  async function collectDroppedFilesForFileManager(event) {
    const dt = event && event.dataTransfer;
    if (!dt) return { count: 0, dropped: null, mapped: [], reason: "no_data_transfer" };

    const dropped = await collectDroppedFiles(dt);
    let mapped = mapFilesForFlutterQueue(dropped.files);
    const normalizedStats = normalizeDropStats(dropped.stats);
    const relativePathCountBefore = mapped.filter((item) => String((item && item.d) || "").length > 0).length;
    const relativePathMissingBefore = Math.max(0, mapped.length - relativePathCountBefore);
    if (normalizedStats.directory_hint && mapped.length > 0) {
      if (relativePathCountBefore === 0) {
        emitDebug("bridge_file_manager_drop_missing_relative_path", {
          reason: "directory_intent_pathless",
          count: mapped.length,
          relative_path_count: 0,
          relative_path_missing_count: relativePathMissingBefore,
          collect_mode: dropped.mode,
          ...normalizedStats,
        });
        return { count: 0, dropped, mapped: [], reason: "directory_missing_relative_path" };
      }
      if (relativePathMissingBefore > 0) {
        mapped = mapped.filter((item) => String((item && item.d) || "").length > 0);
        emitDebug("bridge_file_manager_drop_partial_relative_path", {
          reason: "directory_partial_pathless_filtered",
          count: mapped.length,
          dropped_count: relativePathMissingBefore,
          relative_path_count: mapped.length,
          relative_path_missing_count: 0,
          collect_mode: dropped.mode,
          ...normalizedStats,
        });
      }
    }

    if (mapped.length === 0) {
      return { count: 0, dropped, mapped: [], reason: "expanded_empty" };
    }

    const relativePathCount = mapped.filter((item) => String((item && item.d) || "").length > 0).length;
    const relativePathMissingCount = Math.max(0, mapped.length - relativePathCount);
    emitDebug("bridge_file_manager_drop_capture", {
      count: mapped.length,
      collect_mode: dropped.mode,
      expanded_count: dropped.files.length,
      relative_path_count: relativePathCount,
      relative_path_missing_count: relativePathMissingCount,
      ...normalizedStats,
    });
    return { count: mapped.length, dropped, mapped, reason: "ok" };
  }

  function handleDragEnter(event) {
    if (!hasFilePayload(event)) return;
    event.preventDefault();
    if (!switchedInCurrentDrag && !isFileManagerTabActive()) {
      switchedInCurrentDrag = switchToTransferTab();
    }
  }

  function handleDragOver(event) {
    if (!hasFilePayload(event)) return;
    event.preventDefault();
    if (!switchedInCurrentDrag && !isFileManagerTabActive()) {
      switchedInCurrentDrag = switchToTransferTab();
    }
  }

  async function handleDrop(event) {
    if (!hasFilePayload(event)) return;
    // Prevent browser default "open file" navigation while keeping
    // downstream drop listeners active.
    event.preventDefault();
    if (isFileManagerTabActive()) {
      clearPendingHandoff();
      let captured = 0;
      let dropped = null;
      let mapped = [];
      let captureReason = "unknown";
      try {
        const result = await collectDroppedFilesForFileManager(event);
        captured = Number(result && result.count) || 0;
        dropped = result && result.dropped ? result.dropped : null;
        mapped = Array.isArray(result && result.mapped) ? result.mapped : [];
        captureReason = String((result && result.reason) || "unknown");
      } catch (err) {
        emitDebug("bridge_file_manager_drop_capture_error", {
          msg: String(err),
        });
        captured = 0;
        captureReason = "capture_throw";
      }

      if (captured <= 0) {
        const normalizedStats = normalizeDropStats(dropped ? dropped.stats : null);
        emitDebug("bridge_file_manager_drop_no_files", {
          reason: captureReason || "expanded_empty",
          collect_mode: dropped ? dropped.mode : "unknown",
          ...normalizedStats,
        });
        if (normalizedStats.directory_hint && captureReason === "directory_missing_relative_path") {
          showToast(
            isZh()
              ? "文件夹已识别，但未恢复出目录相对路径，已阻止扁平化上传。请改用“选择文件/文件夹”。"
              : "Folder drop was detected but no relative paths were recovered, so flat upload was blocked. Use Pick files/folders instead.",
          );
        } else if (normalizedStats.directory_hint) {
          showToast(
            isZh()
              ? "文件夹拖拽已捕获，但浏览器未返回可上传文件。请尝试使用“选择文件”。"
              : "Folder drop was captured, but no uploadable files were returned by this browser. Try Pick files instead.",
          );
        }
        switchedInCurrentDrag = false;
        return;
      }

      const destination = getFileManagerCurrentPath();
      if (!destination) {
        emitDebug("bridge_file_manager_drop_no_dest", {
          reason: "missing_current_dir",
          count: captured,
        });
        showToast(
          isZh()
            ? "无法读取文件管理当前目录，已取消上传。"
            : "Cannot read current File Manager directory. Upload was canceled.",
        );
        switchedInCurrentDrag = false;
        return;
      }

      const confirmMessage = buildFileManagerDropConfirmMessage(destination, captured);
      let confirmed = false;
      try {
        confirmed = !!window.confirm(confirmMessage);
      } catch (err) {
        emitDebug("bridge_file_manager_drop_confirm_error", {
          msg: String(err),
          count: captured,
          dest_path: destination,
        });
        confirmed = false;
      }

      emitDebug("bridge_file_manager_drop_confirm", {
        count: captured,
        dest_path: destination,
        confirmed,
      });

      if (!confirmed) {
        emitDebug("bridge_file_manager_drop_cancel", {
          count: captured,
          dest_path: destination,
        });
        switchedInCurrentDrag = false;
        return;
      }

      try {
        const uploaded = await uploadMappedFilesToDirectory(mapped, destination);
        emitDebug("bridge_file_manager_drop_upload_ok", {
          count: captured,
          uploaded,
          dest_path: destination,
        });
        if (uploaded > 0) {
          showToast(
            isZh()
              ? `已上传 ${uploaded} 个文件至 ${destination}`
              : `Uploaded ${uploaded} file(s) to ${destination}`,
          );
          refreshFileManagerCurrentDirectory();
        } else {
          showToast(
            isZh()
              ? "未检测到可上传的文件。"
              : "No uploadable files were detected.",
          );
        }
      } catch (err) {
        emitDebug("bridge_file_manager_drop_upload_fail", {
          msg: String(err),
          count: captured,
          dest_path: destination,
        });
        showToast(
          isZh()
            ? "上传失败，请重试。"
            : "Upload failed. Please retry.",
        );
      }

      switchedInCurrentDrag = false;
      return;
    }

    let queued = 0;
    let dropped = null;
    let queueReason = "unknown";
    try {
      const result = await queueDroppedFiles(event);
      queued = Number(result && result.count) || 0;
      dropped = result && result.dropped ? result.dropped : null;
      queueReason = String(result && result.reason || "unknown");
    } catch (err) {
      emitDebug("bridge_drop_capture_error", {
        msg: String(err),
      });
      queued = 0;
      queueReason = "queue_throw";
    }
    switchToTransferTab();
    if (queued > 0) {
      attemptDeferredHandoff("drop");
      scheduleHandoff("drop_retry");
    } else {
      const normalizedStats = normalizeDropStats(dropped ? dropped.stats : null);
      emitDebug("bridge_drop_no_files", {
        reason: queueReason || "expanded_empty",
        collect_mode: dropped ? dropped.mode : "unknown",
        ...normalizedStats,
      });
      if (normalizedStats.directory_hint && queueReason === "directory_missing_relative_path") {
        showToast(
          isZh()
            ? "文件夹已识别，但未恢复出目录相对路径，已阻止扁平化上传。请改用“选择文件/文件夹”。"
            : "Folder drop was detected but no relative paths were recovered, so flat upload was blocked. Use Pick files/folders instead.",
        );
      } else if (normalizedStats.directory_hint) {
        showToast(
          isZh()
            ? "文件夹拖拽已捕获，但浏览器未返回可上传文件。请尝试进入文件传输页后使用“选择文件”。"
            : "Folder drop was captured, but no uploadable files were returned by this browser. Try Pick files in Transfer tab.",
        );
      }
    }
    switchedInCurrentDrag = false;
  }

  function handleDragEnd(event) {
    if (!hasFilePayload(event)) return;
    switchedInCurrentDrag = false;
  }

  function init() {
    let entryApiSupported = false;
    let handleApiSupported = false;
    try {
      const dt = new DataTransfer();
      const item = dt.items && dt.items.length > 0 ? dt.items[0] : null;
      entryApiSupported = !!(item && typeof item.webkitGetAsEntry === "function");
      handleApiSupported = !!(item && typeof item.getAsFileSystemHandle === "function");
    } catch (_err) {}
    emitDebug("bridge_init", {
      rev: SCRIPT_REV,
      entry_api_supported: entryApiSupported,
      handle_api_supported: handleApiSupported,
    });

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
