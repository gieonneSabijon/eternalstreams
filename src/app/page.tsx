"use client";

import React, { useState, useEffect, useRef } from "react";
import {
  Radio,
  Tv,
  Play,
  Square,
  Trash2,
  Pencil,
  Eye,
  EyeOff,
  UploadCloud,
  CheckCircle2,
  AlertCircle,
  X,
  Server,
  HardDrive,
  Loader2,
  Check,
  GripVertical,
  Terminal
} from "lucide-react";

interface FileItem {
  name: string;
  size: number;
}

export default function EternalStreamDashboard() {
  // Config & Status States
  const [status, setStatus] = useState<"live" | "offline">("offline");
  const [streamKey, setStreamKey] = useState<string>("");

  // File Library States
  const [files, setFiles] = useState<FileItem[]>([]);
  const [isLoadingFiles, setIsLoadingFiles] = useState<boolean>(true);

  // Drag and Drop reordering states
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  // Form/Action States
  const [showStreamKey, setShowStreamKey] = useState<boolean>(false);
  const [isUploading, setIsUploading] = useState<boolean>(false);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [dragActive, setDragActive] = useState<boolean>(false);
  const [isActionLoading, setIsActionLoading] = useState<boolean>(false);

  // Inline Rename States
  const [renamingFile, setRenamingFile] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState<string>("");
  const [deletingFile, setDeletingFile] = useState<string | null>(null);

  // Toast Notification State
  const [toast, setToast] = useState<{ message: string; type: "success" | "error" } | null>(null);

  // Logs State
  const [logs, setLogs] = useState<string>("");
  const [isRefreshingLogs, setIsRefreshingLogs] = useState<boolean>(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const showToast = (message: string, type: "success" | "error" = "success") => {
    setToast({ message, type });
    // Auto-clear toast
    setTimeout(() => {
      setToast(null);
    }, 4500);
  };

  const refreshFiles = async () => {
    setIsLoadingFiles(true);
    try {
      const res = await fetch("/api/files");
      if (res.ok) {
        const data = await res.json();
        setFiles(data.files || []);
      } else {
        showToast("Could not retrieve media files from server storage.", "error");
      }
    } catch (err) {
      showToast("Error communicating with file directory.", "error");
    } finally {
      setIsLoadingFiles(false);
    }
  };

  const fetchLogs = async () => {
    setIsRefreshingLogs(true);
    try {
      const res = await fetch("/api/logs");
      if (res.ok) {
        const data = await res.json();
        setLogs(data.logs || "");
      }
    } catch (err) {
      console.error("Error fetching logs:", err);
    } finally {
      setIsRefreshingLogs(false);
    }
  };

  const handleCopyLogs = () => {
    if (logs) {
      navigator.clipboard.writeText(logs);
      showToast("Logs copied to clipboard!", "success");
    }
  };

  // Sync dashboard state on mount
  useEffect(() => {
    async function initDashboard() {
      try {
        const res = await fetch("/api/stream", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "status" })
        });
        if (res.ok) {
          const config = await res.json();
          setStatus(config.status);
          setStreamKey(config.streamKey || "");
        } else {
          showToast("Failed to connect to VPS streaming engine.", "error");
        }
      } catch (err) {
        showToast("Error establishing connection with stream configurations.", "error");
      }

      // Fetch files list
      await refreshFiles();
      // Fetch initial logs
      await fetchLogs();
    }

    initDashboard();
  }, []);

  // Poll logs when live
  useEffect(() => {
    let interval: NodeJS.Timeout;
    if (status === "live") {
      fetchLogs(); // Initial check
      interval = setInterval(() => {
        fetchLogs();
      }, 4000);
    }
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [status]);

  // Format bytes helper
  const formatBytes = (bytes: number) => {
    if (bytes === 0) return "0 Bytes";
    const k = 1024;
    const sizes = ["Bytes", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
  };

  // Drag and Drop playlist reordering functions
  const handleDragStartItem = (e: React.DragEvent, index: number) => {
    if (renamingFile) {
      e.preventDefault();
      return;
    }
    setDraggedIndex(index);
    e.dataTransfer.effectAllowed = "move";
  };

  const handleDragOverItem = (e: React.DragEvent, index: number) => {
    e.preventDefault();
    if (draggedIndex === null || draggedIndex === index) return;
    setDragOverIndex(index);
  };

  const handleDropItem = async (e: React.DragEvent, index: number) => {
    e.preventDefault();
    if (draggedIndex === null || draggedIndex === index) return;

    const newFiles = [...files];
    const draggedItem = newFiles[draggedIndex];
    newFiles.splice(draggedIndex, 1);
    newFiles.splice(index, 0, draggedItem);

    setFiles(newFiles);

    // Save the reordered playlist immediately to the backend config
    const newPlaylist = newFiles.map(f => f.name);
    try {
      const res = await fetch("/api/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reorder", playlist: newPlaylist })
      });
      if (res.ok) {
        showToast("Library loop sequence updated on server.", "success");
      } else {
        showToast("Server rejected playlist sequence update.", "error");
      }
    } catch (err) {
      showToast("Error syncing loop sequence with VPS.", "error");
    }

    setDraggedIndex(null);
    setDragOverIndex(null);
  };

  const handleDragEndItem = () => {
    setDraggedIndex(null);
    setDragOverIndex(null);
  };

  // Upload Logic
  const handleFileUpload = async (file: File) => {
    const validExtensions = [".mp4", ".mkv", ".avi", ".mov", ".webm", ".flv", ".wmv"];
    const fileExt = file.name.substring(file.name.lastIndexOf(".")).toLowerCase();

    if (!validExtensions.includes(fileExt) && !file.type.startsWith("video/")) {
      showToast("Selected file must be a valid video format.", "error");
      return;
    }

    setIsUploading(true);
    setUploadProgress(0);

    const CHUNK_SIZE = 10 * 1024 * 1024; // 10MB chunks
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
    const uploadId = Date.now().toString() + "_" + Math.random().toString(36).substring(2, 8);

    try {
      for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
        const start = chunkIndex * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, file.size);
        const chunk = file.slice(start, end);

        const formData = new FormData();
        formData.append("file", chunk, file.name);
        formData.append("chunkIndex", chunkIndex.toString());
        formData.append("totalChunks", totalChunks.toString());
        formData.append("fileName", file.name);
        formData.append("uploadId", uploadId);

        const res = await fetch("/api/upload", {
          method: "POST",
          body: formData
        });

        if (!res.ok) {
          const errData = await res.json();
          throw new Error(errData.error || `Chunk ${chunkIndex + 1}/${totalChunks} upload failed.`);
        }

        const progressPercent = Math.round(((chunkIndex + 1) / totalChunks) * 100);
        setUploadProgress(progressPercent);
      }

      showToast(`"${file.name}" uploaded successfully!`, "success");
      await refreshFiles();
    } catch (err: any) {
      showToast(err.message || "Network failure during upload.", "error");
    } finally {
      setTimeout(() => {
        setIsUploading(false);
        setUploadProgress(null);
      }, 500);
    }
  };

  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") {
      setDragActive(true);
    } else if (e.type === "dragleave") {
      setDragActive(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);

    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      handleFileUpload(e.dataTransfer.files[0]);
    }
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      handleFileUpload(e.target.files[0]);
    }
  };

  const triggerFileInput = () => {
    fileInputRef.current?.click();
  };

  // Delete File Logic
  const executeDelete = async (filename: string) => {
    try {
      const res = await fetch(`/api/delete?file=${encodeURIComponent(filename)}`, {
        method: "DELETE"
      });

      if (res.ok) {
        showToast("File deleted successfully!", "success");
        setDeletingFile(null);
        await refreshFiles();
      } else {
        const errData = await res.json();
        showToast(errData.error || "Delete command failed.", "error");
      }
    } catch (err) {
      showToast("Could not communicate with delete engine.", "error");
    }
  };

  // Rename File Logic
  const startRename = (filename: string) => {
    setRenamingFile(filename);
    setRenameValue(filename);
  };

  const handleRenameSubmit = async (oldName: string) => {
    const trimmed = renameValue.trim();
    if (!trimmed) {
      showToast("Filename cannot be empty.", "error");
      return;
    }
    if (trimmed === oldName) {
      setRenamingFile(null);
      return;
    }

    let finalName = trimmed;
    const oldExt = oldName.substring(oldName.lastIndexOf("."));
    if (!finalName.endsWith(oldExt)) {
      finalName += oldExt;
    }

    try {
      const res = await fetch("/api/rename", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ oldName, newName: finalName })
      });

      if (res.ok) {
        showToast(`Renamed successfully to "${finalName}"!`, "success");
        setRenamingFile(null);
        await refreshFiles();
      } else {
        const err = await res.json();
        showToast(err.error || "Rename rejected by VPS.", "error");
      }
    } catch (e) {
      showToast("Network error when attempting rename.", "error");
    }
  };

  // Start / Stop broadcast
  const toggleBroadcast = async () => {
    if (status === "offline") {
      setIsActionLoading(true);
      try {
        const res = await fetch("/api/stream", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "start",
            streamKey: streamKey.trim()
          })
        });

        if (res.ok) {
          setStatus("live");
          showToast("Live stream broadcast initiated successfully!", "success");
        } else {
          const err = await res.json();
          showToast(err.error || "Failed to start broadcast engine.", "error");
        }
      } catch (err) {
        showToast("Error starting live broadcast on VPS.", "error");
      } finally {
        setIsActionLoading(false);
      }
    } else {
      setIsActionLoading(true);
      try {
        const res = await fetch("/api/stream", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "stop" })
        });

        if (res.ok) {
          setStatus("offline");
          showToast("Live broadcast stopped safely.", "success");
        } else {
          const err = await res.json();
          showToast(err.error || "Failed to stop broadcast engine.", "error");
        }
      } catch (err) {
        showToast("Error stopping live broadcast on VPS.", "error");
      } finally {
        setIsActionLoading(false);
      }
    }
  };

  const handleSaveStreamKey = async () => {
    try {
      const res = await fetch("/api/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "save_key", streamKey: streamKey.trim() })
      });
      if (res.ok) {
        showToast("Stream key saved successfully!", "success");
      } else {
        showToast("Failed to save stream key on VPS.", "error");
      }
    } catch (err) {
      showToast("Error communicating with stream configuration.", "error");
    }
  };

  return (
    <div className="flex-1 w-full min-h-screen bg-twitch-bg-darker text-[#efeff1] relative">

      {/* Sliding Toast Alert */}
      {toast && (
        <div className={`fixed top-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 px-6 py-4 rounded-lg shadow-2xl border transition-all duration-300 transform translate-y-0 animate-bounce ${toast.type === "success"
          ? "bg-emerald-950/90 border-emerald-500/30 text-emerald-200"
          : "bg-red-950/90 border-red-500/30 text-red-200"
          }`}>
          {toast.type === "success" ? <CheckCircle2 className="w-5 h-5 text-emerald-400" /> : <AlertCircle className="w-5 h-5 text-red-400" />}
          <span className="font-medium text-sm tracking-wide">{toast.message}</span>
          <button
            id="dismiss-toast"
            onClick={() => setToast(null)}
            className="ml-3 hover:text-white transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Main Container */}
      <div className="max-w-7xl mx-auto px-4 py-8 md:py-12 flex flex-col gap-8">

        {/* Header Section */}
        <header className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 pb-6 border-b border-twitch-bg-light">
          <div className="flex items-center gap-4">
            <div className="p-3 bg-twitch-purple rounded-xl shadow-lg glow-purple">
              <Radio className="w-7 h-7 text-white animate-pulse" />
            </div>
            <div>
              <h1 className="text-3xl font-extrabold tracking-tight text-white flex items-center gap-2">
                Eternal Stream
              </h1>
              <p className="text-xs font-semibold text-zinc-400 tracking-widest uppercase flex items-center gap-1.5 mt-0.5">
                24/7 Streamer by Gieonne Sabijon
              </p>
            </div>
          </div>

          {/* Status Badge */}
          <div
            id="status-badge"
            className={`flex items-center gap-2.5 px-4.5 py-2.5 rounded-full border font-bold text-sm tracking-wider shadow-md transition-all duration-300 ${status === "live"
              ? "bg-red-950/30 border-twitch-crimson text-white glow-crimson"
              : "bg-zinc-900/50 border-zinc-700 text-zinc-400"
              }`}
          >
            <span className={`w-3 h-3 rounded-full ${status === "live" ? "bg-twitch-crimson animate-ping" : "bg-zinc-600"}`}></span>
            <span className={`w-3 h-3 rounded-full absolute ${status === "live" ? "bg-twitch-crimson" : "bg-zinc-600"}`}></span>
            <span className="pl-4">
              {status === "live" ? "🟢 LIVE ON TWITCH" : "🔴 STREAM OFFLINE"}
            </span>
          </div>
        </header>

        {/* Dashboard Content Grid */}
        <main className="grid grid-cols-1 lg:grid-cols-3 gap-8">

          {/* Left Column (Library, Upload, Config) */}
          <section className="lg:col-span-2 flex flex-col gap-8">

            {/* Video Library Card */}
            <div className="bg-twitch-bg-dark rounded-xl border border-zinc-800 shadow-xl overflow-hidden">
              <div className="px-6 py-5 border-b border-zinc-800 flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <Tv className="w-5 h-5 text-twitch-purple" />
                  <h2 className="text-lg font-bold text-white">Video Library</h2>
                </div>
                <div className="flex items-center gap-1.5 text-xs text-zinc-400 font-semibold bg-twitch-bg-light px-2.5 py-1 rounded-md">
                  <span>{files.length} Videos</span>
                </div>
              </div>

              {/* List View Container */}
              <div className="p-6">
                {isLoadingFiles ? (
                  <div className="flex flex-col items-center justify-center py-16 text-zinc-500 gap-3">
                    <Loader2 className="w-8 h-8 text-twitch-purple animate-spin" />
                    <p className="text-sm font-medium">Scanning VPS file directory...</p>
                  </div>
                ) : files.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-16 text-zinc-500 border-2 border-dashed border-zinc-800 rounded-lg">
                    <Tv className="w-12 h-12 mb-3 text-zinc-700" />
                    <p className="text-sm font-semibold">No videos found on server</p>
                    <p className="text-xs text-zinc-600 mt-1">Upload a video below to start your broadcast</p>
                  </div>
                ) : (
                  <div className="max-h-[380px] overflow-y-auto pr-1 flex flex-col gap-3">
                    {files.map((file, index) => (
                      deletingFile === file.name ? (
                        <div
                          key={file.name}
                          className="flex items-center justify-between p-4 rounded-lg border bg-twitch-crimson/10 border-twitch-crimson/30 animate-pulse"
                        >
                          <div className="flex items-center gap-3.5 flex-1 min-w-0 mr-4">
                            <AlertCircle className="w-5 h-5 text-twitch-crimson" />
                            <span className="text-sm font-semibold text-zinc-100 truncate">
                              Delete "{file.name}" permanently?
                            </span>
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            <button
                              id={`confirm-delete-${file.name}`}
                              onClick={() => executeDelete(file.name)}
                              className="px-3.5 py-1.5 bg-twitch-crimson hover:bg-twitch-crimson-hover text-white rounded text-xs font-bold transition-all duration-200 cursor-pointer shadow-lg"
                            >
                              Delete
                            </button>
                            <button
                              id={`cancel-delete-${file.name}`}
                              onClick={() => setDeletingFile(null)}
                              className="px-3.5 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded text-xs font-bold transition-all duration-200 cursor-pointer"
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div
                          key={file.name}
                          draggable={!renamingFile}
                          onDragStart={(e) => handleDragStartItem(e, index)}
                          onDragOver={(e) => handleDragOverItem(e, index)}
                          onDrop={(e) => handleDropItem(e, index)}
                          onDragEnd={handleDragEndItem}
                          className={`flex items-center justify-between p-4 rounded-lg border transition-all duration-200 relative ${draggedIndex === index
                            ? "opacity-30 border-dashed border-twitch-purple bg-twitch-purple/5"
                            : dragOverIndex === index
                              ? "border-twitch-purple bg-twitch-purple/10 scale-[1.01]"
                              : "bg-twitch-bg-light/60 border-zinc-800/80 hover:border-zinc-700 hover:bg-twitch-bg-light"
                            }`}
                        >
                          {/* Drag Handle & Details or Rename Input */}
                          <div className="flex items-center gap-3.5 flex-1 min-w-0 mr-4">

                            {/* Grip Handle */}
                            <div
                              className="cursor-grab active:cursor-grabbing p-1.5 hover:bg-zinc-800 rounded text-zinc-500 hover:text-zinc-300 transition-colors"
                              title="Drag to change sequence order"
                            >
                              <GripVertical className="w-4 h-4" />
                            </div>

                            <div className={`p-2 rounded bg-zinc-800 text-zinc-400`}>
                              <Tv className="w-4 h-4" />
                            </div>

                            {renamingFile === file.name ? (
                              <div className="flex items-center gap-2 w-full max-w-md">
                                <input
                                  id={`rename-input-${file.name}`}
                                  type="text"
                                  value={renameValue}
                                  onChange={(e) => setRenameValue(e.target.value)}
                                  className="bg-twitch-bg-darker border border-zinc-700 rounded px-2.5 py-1 text-sm text-white focus:outline-none focus:border-twitch-purple w-full font-medium"
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter") handleRenameSubmit(file.name);
                                    if (e.key === "Escape") setRenamingFile(null);
                                  }}
                                  autoFocus
                                />
                                <button
                                  id={`save-rename-${file.name}`}
                                  onClick={() => handleRenameSubmit(file.name)}
                                  className="p-1 bg-emerald-600 hover:bg-emerald-500 rounded text-white transition-colors"
                                  title="Save filename"
                                >
                                  <Check className="w-4 h-4" />
                                </button>
                                <button
                                  id={`cancel-rename-${file.name}`}
                                  onClick={() => setRenamingFile(null)}
                                  className="p-1 bg-zinc-700 hover:bg-zinc-600 rounded text-zinc-200 transition-colors"
                                  title="Cancel"
                                >
                                  <X className="w-4 h-4" />
                                </button>
                              </div>
                            ) : (
                              <div className="truncate">
                                <div className="font-semibold text-sm text-zinc-100 truncate flex items-center gap-2">
                                  <span className="truncate">{file.name}</span>
                                </div>
                                <div className="text-xs text-zinc-500 font-medium mt-0.5">
                                  Size: {formatBytes(file.size)}
                                </div>
                              </div>
                            )}
                          </div>

                          {/* File Action buttons */}
                          {renamingFile !== file.name && (
                            <div className="flex items-center gap-1.5 shrink-0">
                              <button
                                id={`rename-btn-${file.name}`}
                                onClick={() => startRename(file.name)}
                                onMouseDown={(e) => e.stopPropagation()}
                                draggable={false}
                                className="p-2 hover:bg-zinc-800 rounded text-zinc-400 hover:text-white transition-all duration-200"
                                title="Rename File"
                              >
                                <Pencil className="w-4.5 h-4.5" />
                              </button>
                              <button
                                id={`delete-btn-${file.name}`}
                                onClick={() => setDeletingFile(file.name)}
                                onMouseDown={(e) => e.stopPropagation()}
                                draggable={false}
                                className="p-2 hover:bg-zinc-800 rounded text-zinc-400 hover:text-twitch-crimson transition-all duration-200"
                                title="Delete File"
                              >
                                <Trash2 className="w-4.5 h-4.5" />
                              </button>
                            </div>
                          )}
                        </div>
                      )
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Upload Zone Card */}
            <div className="bg-twitch-bg-dark rounded-xl border border-zinc-800 shadow-xl overflow-hidden">
              <div className="px-6 py-5 border-b border-zinc-800 flex items-center gap-2.5">
                <UploadCloud className="w-5 h-5 text-twitch-purple" />
                <h2 className="text-lg font-bold text-white">Upload New Video</h2>
              </div>
              <div className="p-6">
                <div
                  id="drop-zone"
                  onDragEnter={handleDrag}
                  onDragOver={handleDrag}
                  onDragLeave={handleDrag}
                  onDrop={handleDrop}
                  onClick={triggerFileInput}
                  className={`border-2 border-dashed rounded-xl py-10 px-6 text-center cursor-pointer transition-all duration-300 flex flex-col items-center justify-center ${dragActive
                    ? "border-twitch-purple bg-twitch-purple/5 scale-[0.99]"
                    : "border-zinc-800 hover:border-zinc-700 bg-twitch-bg-light/20 hover:bg-twitch-bg-light/40"
                    }`}
                >
                  <input
                    id="file-upload-input"
                    ref={fileInputRef}
                    type="file"
                    className="hidden"
                    accept="video/*"
                    onChange={handleFileInputChange}
                    disabled={isUploading}
                  />

                  {isUploading ? (
                    <div className="flex flex-col items-center justify-center gap-3">
                      <div className="relative flex items-center justify-center">
                        <Loader2 className="w-12 h-12 text-twitch-purple animate-spin" />
                        <span className="absolute text-[10px] font-bold text-twitch-purple">
                          {uploadProgress !== null ? `${uploadProgress}%` : ""}
                        </span>
                      </div>
                      <p className="text-sm font-semibold text-zinc-300">Uploading media to VPS directory...</p>
                      <div className="w-48 bg-zinc-800 h-1.5 rounded-full overflow-hidden mt-1.5">
                        <div
                          className="bg-twitch-purple h-full transition-all duration-200"
                          style={{ width: `${uploadProgress || 0}%` }}
                        ></div>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="p-4 bg-twitch-bg-light/60 rounded-full mb-3.5 border border-zinc-800">
                        <UploadCloud className="w-7 h-7 text-zinc-400" />
                      </div>
                      <p className="font-semibold text-sm text-zinc-200">
                        Drag & drop any video file here
                      </p>
                      <p className="text-xs text-zinc-500 mt-1.5 font-medium">
                        or <span className="text-twitch-purple hover:underline">Click to browse files</span>
                      </p>
                    </>
                  )}
                </div>
              </div>
            </div>

            {/* Stream Security Key Card */}
            <div className="bg-twitch-bg-dark rounded-xl border border-zinc-800 shadow-xl p-6">
              <h2 className="text-lg font-bold text-white mb-1.5">Stream Security Key</h2>
              <p className="text-xs text-zinc-500 font-medium mb-4">
                Input your Twitch Stream Key to start streaming.
              </p>
              <div className="relative flex items-center">
                <input
                  id="stream-key-input"
                  type={showStreamKey ? "text" : "password"}
                  value={streamKey}
                  onChange={(e) => setStreamKey(e.target.value)}
                  onBlur={handleSaveStreamKey}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.currentTarget.blur();
                    }
                  }}
                  placeholder="Stream Key..."
                  className="bg-twitch-bg-darker border border-zinc-800 rounded-lg pl-4 pr-12 py-3.5 text-sm text-white focus:outline-none focus:border-twitch-purple w-full font-mono placeholder-zinc-700 tracking-wide"
                  disabled={status === "live"}
                />
                <button
                  id="toggle-stream-key"
                  type="button"
                  onClick={() => setShowStreamKey(!showStreamKey)}
                  className="absolute right-3.5 p-1 rounded-md text-zinc-400 hover:text-white transition-colors focus:outline-none"
                  title={showStreamKey ? "Hide Stream Key" : "Show Stream Key"}
                >
                  {showStreamKey ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                </button>
              </div>
            </div>

          </section>

          {/* Right Column Sidebar (Live Engine Control) */}
          <section className="flex flex-col gap-6">

            {/* Monitoring Widget & Summary matrix */}
            <div className="bg-twitch-bg-dark rounded-xl border border-zinc-800 shadow-xl overflow-hidden">
              <div className="px-6 py-5 border-b border-zinc-800">
                <h2 className="text-lg font-bold text-white flex items-center gap-2">
                  <span className="flex h-2 w-2 relative">
                    <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${status === "live" ? "bg-red-500" : "bg-zinc-500"}`}></span>
                    <span className={`relative inline-flex rounded-full h-2 w-2 ${status === "live" ? "bg-red-500" : "bg-zinc-500"}`}></span>
                  </span>
                  Live Control Engine
                </h2>
              </div>

              <div className="p-6 flex flex-col gap-6">

                {/* Data Matrix summary card */}
                <div className="bg-twitch-bg-darker border border-zinc-800 rounded-lg p-5 flex flex-col gap-4 font-medium">

                  <div>
                    <div className="text-[10px] text-zinc-500 font-bold uppercase tracking-wider">Target Platform</div>
                    <div className="text-sm text-zinc-200 mt-1 flex items-center gap-1.5 font-bold">
                      <span className="inline-block w-1.5 h-1.5 rounded-full bg-twitch-purple"></span>
                      Twitch
                    </div>
                  </div>

                  <div className="border-t border-zinc-800/80 pt-3.5">
                    <div className="text-[10px] text-zinc-500 font-bold uppercase tracking-wider">Playback Mode</div>
                    <div className="text-sm text-zinc-200 mt-1 flex items-center gap-1.5 font-bold">
                      <span className="inline-block w-1.5 h-1.5 rounded-full bg-twitch-purple"></span>
                      Continuous Library Loop (24/7)
                    </div>
                  </div>

                  <div className="border-t border-zinc-800/80 pt-3.5">
                    <div className="text-[10px] text-zinc-500 font-bold uppercase tracking-wider block mb-2">
                      Stream Queue Order
                    </div>

                    {isLoadingFiles ? (
                      <div className="flex items-center gap-2 py-2 text-xs text-zinc-500 font-medium">
                        <Loader2 className="w-3.5 h-3.5 text-twitch-purple animate-spin" />
                        <span>Scanning queue sequence...</span>
                      </div>
                    ) : files.length === 0 ? (
                      <p className="text-xs text-red-500 font-bold py-1">
                        * Upload videos to populate playlist queue
                      </p>
                    ) : (
                      <div className="flex flex-col gap-2 max-h-[220px] overflow-y-auto pr-1">
                        {files.map((file, idx) => (
                          <div
                            key={file.name}
                            className="flex items-center justify-between text-xs text-zinc-300 bg-twitch-bg-light/40 px-3 py-2.5 rounded border border-zinc-850/60 truncate hover:bg-twitch-bg-light/65 transition-colors"
                          >
                            <span className="truncate max-w-[170px] font-bold text-zinc-200">
                              {idx + 1}. {file.name}
                            </span>
                            <span className="text-[10px] text-zinc-500 font-semibold shrink-0 ml-1">
                              {formatBytes(file.size)}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                </div>

                {/* Macro Call-to-action Button */}
                <button
                  id="broadcast-toggle-btn"
                  onClick={toggleBroadcast}
                  disabled={isActionLoading}
                  className={`w-full py-4.5 px-6 rounded-xl font-extrabold text-base tracking-wide flex items-center justify-center gap-3 transition-all duration-300 shadow-xl cursor-pointer ${isActionLoading
                    ? "bg-zinc-800 text-zinc-500 cursor-not-allowed"
                    : status === "live"
                      ? "bg-twitch-crimson hover:bg-twitch-crimson-hover text-white hover:shadow-red-950/20 active:scale-[0.98] glow-crimson"
                      : "bg-twitch-purple hover:bg-twitch-purple-hover text-white hover:shadow-purple-950/20 active:scale-[0.98] glow-purple"
                    }`}
                >
                  {isActionLoading ? (
                    <>
                      <Loader2 className="w-5 h-5 animate-spin" />
                      <span>Syncing Engine...</span>
                    </>
                  ) : status === "live" ? (
                    <>
                      <Square className="w-5 h-5 fill-white text-white" />
                      <span>Stop Live Broadcast</span>
                    </>
                  ) : (
                    <>
                      <Play className="w-5 h-5 fill-white text-white" />
                      <span>Start 24/7 Stream</span>
                    </>
                  )}
                </button>

              </div>
            </div>

            {/* Live Stream Logs Card */}
            <div className="bg-twitch-bg-dark rounded-xl border border-zinc-800 shadow-xl p-6 flex flex-col gap-4">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-bold text-white flex items-center gap-2">
                  <Terminal className="w-5 h-5 text-twitch-purple" />
                  Engine Logs
                </h2>
                <div className="flex items-center gap-3">
                  {logs && (
                    <button
                      onClick={handleCopyLogs}
                      className="text-xs text-twitch-purple hover:text-twitch-purple-hover hover:underline font-bold flex items-center gap-1 cursor-pointer"
                    >
                      Copy Logs
                    </button>
                  )}
                  <button
                    onClick={fetchLogs}
                    disabled={isRefreshingLogs}
                    className="text-xs text-twitch-purple hover:text-twitch-purple-hover hover:underline font-bold flex items-center gap-1 cursor-pointer disabled:opacity-50"
                  >
                    {isRefreshingLogs ? (
                      <Loader2 className="w-3 h-3 animate-spin" />
                    ) : null}
                    Refresh
                  </button>
                </div>
              </div>
              <pre className="bg-twitch-bg-darker border border-zinc-850 rounded-lg p-3 text-[11px] font-mono text-zinc-400 overflow-x-auto max-h-60 overflow-y-auto whitespace-pre-wrap leading-relaxed select-text" style={{ userSelect: 'text' }}>
                {logs || "No log entries captured yet."}
              </pre>
            </div>

          </section>

        </main>
      </div>
    </div>
  );
}
