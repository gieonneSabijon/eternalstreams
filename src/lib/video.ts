import { exec, spawn, execSync, execFile } from 'child_process';
import util from 'util';
import fs from 'fs';
import path from 'path';
// @ts-ignore
import ffmpegPathRaw from 'ffmpeg-static';

const execPromise = util.promisify(exec);

export function safeAppendToLog(message: string) {
  const logFilePath = path.join(process.cwd(), 'ffmpeg_log.txt');
  try {
    fs.appendFileSync(logFilePath, message);
  } catch (err: any) {
    console.error(`[safeAppendToLog Fail] ${err.message}. Message was: ${message.trim()}`);
  }
}

export interface VideoConfig {
  width: number;
  height: number;
  fps: number;
  sampleRate: number;
  channels: number;
  tbn: number;
  videoStreamIndex: number;
  audioStreamIndex: number;
  codecVideo: string;
  codecAudio: string;
}

export function getCleanedFfmpegPath(): string {
  let ffmpegPath = ffmpegPathRaw || 'ffmpeg';
  if (ffmpegPathRaw) {
    if (fs.existsSync(ffmpegPathRaw)) {
      return ffmpegPathRaw;
    }
    const cleaned = ffmpegPathRaw.replace(/^\\ROOT|^ROOT|^\/ROOT/, '');
    const relativePath = cleaned.startsWith('/') || cleaned.startsWith('\\') ? cleaned.slice(1) : cleaned;
    ffmpegPath = path.resolve(process.cwd(), relativePath);
  }
  return ffmpegPath;
}

export function getFfmpegCommand(): string {
  // If running on the Linux VPS, use the native system FFmpeg binary immediately.
  // This bypasses static build network engine deadlocks on virtual hosting environments.
  if (process.platform === 'linux') {
    try {
      execSync('ffmpeg -version', { stdio: 'ignore' });
      return 'ffmpeg';
    } catch (err) {
      console.warn('System ffmpeg command check failed on Linux, falling back to static binary config...', err);
    }
  }

  const staticPath = getCleanedFfmpegPath();

  // 2. Local fallback / Windows environment strategy: Try static path first
  try {
    if (fs.existsSync(staticPath)) {
      if (process.platform !== 'win32') {
        try {
          fs.chmodSync(staticPath, 0o755);
        } catch (chmodErr) {
          console.warn(`Failed to chmod static ffmpeg binary:`, chmodErr);
        }
      }
      execSync(`"${staticPath}" -version`, { stdio: 'ignore' });
      return staticPath;
    }
  } catch (err) {
    console.warn(`Static FFmpeg binary failed execution check:`, err);
  }

  // 3. Absolute Fallback to system command if it hasn't been checked yet
  if (process.platform !== 'linux') {
    try {
      execSync('ffmpeg -version', { stdio: 'ignore' });
      return 'ffmpeg';
    } catch (err) {
      console.error('System ffmpeg command not found or failed check.');
    }
  }

  return staticPath;
}

export function getFfmpegDiagnostics(): string {
  const staticPath = getCleanedFfmpegPath();
  let log = `=== FFmpeg Environment Diagnostics ===\n`;
  log += `- Static binary path: ${staticPath}\n`;
  log += `- Static binary exists: ${fs.existsSync(staticPath)}\n`;

  if (fs.existsSync(staticPath)) {
    try {
      if (process.platform !== 'win32') {
        try { fs.chmodSync(staticPath, 0o755); } catch { }
      }
      const output = execSync(`"${staticPath}" -version`, { encoding: 'utf-8', timeout: 3000 });
      log += `- Static binary run check: SUCCESS\n  Version header: ${output.split('\n')[0].trim()}\n`;
    } catch (err: any) {
      log += `- Static binary run check: FAILED. Error: ${err.message}\n`;
    }
  }

  try {
    const output = execSync('ffmpeg -version', { encoding: 'utf-8', timeout: 3000 });
    log += `- System 'ffmpeg' check: SUCCESS\n  Version header: ${output.split('\n')[0].trim()}\n`;
  } catch (err: any) {
    log += `- System 'ffmpeg' check: FAILED. Error: ${err.message}\n`;
  }

  log += `======================================\n`;
  return log;
}

export function getVideoConfig(filePath: string, ffmpegPath: string): Promise<VideoConfig> {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath, ['-hide_banner', '-analyzeduration', '1000000', '-probesize', '1000000', '-i', filePath], (err, stdout, stderr) => {
      const output = stderr || '';
      const lines = output.split('\n');

      const videoLine = lines.find(line => line.includes('Stream #') && line.includes('Video:'));
      const audioLine = lines.find(line => line.includes('Stream #') && line.includes('Audio:'));

      let width = null;
      let height = null;
      let fps = 30;
      let tbn = 90000;
      let videoStreamIndex = 0;
      let audioStreamIndex = 1;
      let codecVideo = '';
      let codecAudio = '';

      if (videoLine) {
        const streamMatch = videoLine.match(/Stream #\d+:(\d+)/);
        if (streamMatch) {
          videoStreamIndex = parseInt(streamMatch[1], 10);
        }

        const codecMatch = videoLine.match(/Video:\s*([a-zA-Z0-9_-]+)/);
        codecVideo = codecMatch ? codecMatch[1].toLowerCase() : '';

        const resMatch = videoLine.match(/,\s*(\d{3,5})x(\d{3,5})/);
        width = resMatch ? parseInt(resMatch[1], 10) : null;
        height = resMatch ? parseInt(resMatch[2], 10) : null;

        const fpsMatch = videoLine.match(/,\s*(\d+(?:\.\d+)?)\s*fps/);
        fps = fpsMatch ? parseFloat(fpsMatch[1]) : 30;

        const tbnMatch = videoLine.match(/,\s*(\d+(?:\.\d+)?[kK]?)\s*tbn/);
        if (tbnMatch) {
          const valStr = tbnMatch[1].toLowerCase();
          if (valStr.endsWith('k')) {
            tbn = Math.round(parseFloat(valStr.slice(0, -1)) * 1000);
          } else {
            tbn = Math.round(parseFloat(valStr));
          }
        }
      }

      let sampleRate = 44100;
      let channels = 2;

      if (audioLine) {
        const streamMatch = audioLine.match(/Stream #\d+:(\d+)/);
        if (streamMatch) {
          audioStreamIndex = parseInt(streamMatch[1], 10);
        }

        const codecMatch = audioLine.match(/Audio:\s*([a-zA-Z0-9_-]+)/);
        codecAudio = codecMatch ? codecMatch[1].toLowerCase() : '';

        const arMatch = audioLine.match(/,\s*(\d+)\s*Hz/);
        sampleRate = arMatch ? parseInt(arMatch[1], 10) : 44100;

        if (audioLine.includes('mono')) {
          channels = 1;
        } else if (audioLine.includes('stereo')) {
          channels = 2;
        } else {
          const chanMatch = audioLine.match(/,\s*(\d+)\s*channels/);
          if (chanMatch) {
            channels = parseInt(chanMatch[1], 10);
          }
        }
      }

      if (!width || !height) {
        reject(new Error(`Could not parse video resolution for ${path.basename(filePath)}. Output: ${output.slice(0, 500)}`));
      } else {
        resolve({
          width,
          height,
          fps,
          sampleRate,
          channels,
          tbn,
          videoStreamIndex,
          audioStreamIndex,
          codecVideo,
          codecAudio
        });
      }
    });
  });
}

export function getFreeDiskSpace(dirPath: string): number {
  try {
    if (process.platform === 'win32') {
      const drive = path.resolve(dirPath).substring(0, 2);
      // Try wmic first
      try {
        const output = execSync(`wmic logicaldisk where DeviceID="${drive}" get FreeSpace`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
        const lines = output.trim().split('\n');
        if (lines.length > 1) {
          const freeBytes = parseInt(lines[1].trim(), 10);
          if (!isNaN(freeBytes)) return freeBytes;
        }
      } catch (e) {
        // ignore and fall back to PowerShell
      }
      
      // Fallback: PowerShell (standard on modern Windows)
      try {
        const psOutput = execSync(`powershell -NoProfile -Command "(Get-Volume -DriveLetter ${drive[0]}).SizeRemaining"`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
        const freeBytesPs = parseInt(psOutput.trim(), 10);
        if (!isNaN(freeBytesPs)) return freeBytesPs;
      } catch (e) {
        // ignore
      }
    } else {
      // Linux/macOS
      const output = execSync(`df -B1 "${dirPath}" | tail -n 1 | awk '{print $4}'`, { encoding: 'utf8' });
      const freeBytes = parseInt(output.trim(), 10);
      if (!isNaN(freeBytes)) return freeBytes;
    }
  } catch (err) {
    console.error('Error checking disk space:', err);
  }
  // Fallback to 10 GB
  return 10 * 1024 * 1024 * 1024;
}

export async function getReferenceVideoName(uploadsDir: string, playlist?: string[]): Promise<string | null> {
  if (playlist && playlist.length > 0) {
    return playlist[0];
  }
  if (fs.existsSync(uploadsDir)) {
    const files = fs.readdirSync(uploadsDir)
      .filter((f) => !f.startsWith('temp_') && !f.endsWith('.tmp.mp4'))
      .sort((a, b) => a.localeCompare(b));
    if (files.length > 0) {
      return files[0];
    }
  }
  return null;
}

export async function isNormalized(filePath: string, target: VideoConfig, ffmpegPath: string): Promise<boolean> {
  try {
    const current = await getVideoConfig(filePath, ffmpegPath);
    const isVideoH264 = current.codecVideo.includes('h264') || current.codecVideo.includes('avc');
    return isVideoH264;
  } catch (err) {
    console.error(`Error checking normalization for ${filePath}:`, err);
    return false;
  }
}

export function normalizeVideo(
  filePath: string,
  tempPath: string,
  target: VideoConfig,
  ffmpegPath: string,
  bitrate?: number,
  preset?: string
): Promise<void> {
  console.log(`[Normalization] Bypassed normalizeVideo for "${path.basename(filePath)}" as on-the-fly audio resampling is active.`);
  return Promise.resolve();
}

export function triggerNormalization(
  fileName: string,
  targetConfig: VideoConfig,
  ffmpegPath: string,
  bitrate?: number,
  preset?: string
): void {
  console.log(`[Background] Bypassed background normalization check for "${fileName}".`);
}

export function killLingeringFfmpegProcesses() {
  const playlistName = 'temp_playlist.txt';
  try {
    if (process.platform === 'win32') {
      // Find and kill processes on Windows with temp_playlist.txt in their command line
      const psCommand = `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name = 'ffmpeg.exe'\\" | Where-Object { $_.CommandLine -like '*${playlistName}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"`;
      try {
        execSync(psCommand, { stdio: 'ignore' });
      } catch (err: any) {
        console.warn('PowerShell process cleanup failed, attempting taskkill fallback...', err.message);
        try {
          execSync('taskkill /F /IM ffmpeg.exe', { stdio: 'ignore' });
        } catch (tkErr) {
          // ignore
        }
      }
    } else {
      // Find and kill processes on Linux/macOS
      // Use pkill -9 -f to find processes with 'temp_playlist.txt' in their command line
      try {
        execSync(`pkill -9 -f "${playlistName}"`, { stdio: 'ignore' });
      } catch (err) {
        // pkill exits with 1 if no process matched, which is normal and expected
      }
    }
  } catch (err: any) {
    console.error('Error in killLingeringFfmpegProcesses:', err.message);
  }
}

// Register exit hooks to prevent zombie processes
if (typeof window === 'undefined') {
  if (!(global as any).hasRegisteredExitHooks) {
    (global as any).hasRegisteredExitHooks = true;

    const cleanupAllProcesses = () => {
      console.log('[System Cleanup] Cleaning up child processes before exit...');
      const ffmpegProcess = (global as any).ffmpegProcess;
      if (ffmpegProcess) {
        try {
          ffmpegProcess.kill('SIGKILL');
          console.log('[System Cleanup] Terminated live stream process.');
        } catch (e) {}
      }
      const normalizationProcesses = (global as any).normalizationProcesses;
      if (normalizationProcesses) {
        for (const [fileName, child] of normalizationProcesses.entries()) {
          try {
            child.kill('SIGKILL');
            console.log(`[System Cleanup] Terminated normalization for "${fileName}".`);
          } catch (e) {}
        }
        normalizationProcesses.clear();
      }
    };

    process.on('exit', cleanupAllProcesses);
    process.on('SIGINT', () => {
      cleanupAllProcesses();
      process.exit(0);
    });
    process.on('SIGTERM', () => {
      cleanupAllProcesses();
      process.exit(0);
    });
  }
}

export function ensureStandardTrackOrder(filePath: string, ffmpegPath: string): Promise<void> {
  return new Promise(async (resolve, reject) => {
    try {
      const config = await getVideoConfig(filePath, ffmpegPath);
      if (config.videoStreamIndex === 0) {
        // Track order is already correct (video at 0)
        return resolve();
      }

      // Safeguard #3: Check file lock state / live stream status
      const configPath = path.join(process.cwd(), 'stream-config.json');
      if (fs.existsSync(configPath)) {
        try {
          const configJson = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
          if (configJson.status === 'live' && configJson.playlist.includes(path.basename(filePath))) {
            console.warn(`[Track Swap] Skipping swap for "${path.basename(filePath)}" because stream is live and file is in active playlist.`);
            return resolve();
          }
        } catch (e) {
          // ignore read/parse errors
        }
      }
      
      console.log(`[Track Swap] Swapping tracks in-place for "${path.basename(filePath)}" to enforce video at index 0.`);
      const tempPath = filePath + '.swap.mp4';
      if (fs.existsSync(tempPath)) {
        try { fs.unlinkSync(tempPath); } catch {}
      }

      // Safeguard #2: Handle Optional Audio using -map 0:a?
      const args = [
        '-y',
        '-nostdin',
        '-i', filePath,
        '-map', '0:v:0',
        '-map', '0:a?',
        '-c', 'copy',
        tempPath
      ];

      const child = spawn(ffmpegPath, args);
      let stderr = '';
      child.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      child.on('close', async (code) => {
        if (code === 0) {
          // Safeguard #1: Atomic rename with copyFile + unlink fallback
          try {
            await fs.promises.rename(tempPath, filePath);
            resolve();
          } catch (renameErr: any) {
            try {
              await fs.promises.copyFile(tempPath, filePath);
              await fs.promises.unlink(tempPath);
              resolve();
            } catch (fallbackErr: any) {
              reject(new Error(`Failed to replace file during swap: ${renameErr.message} (Fallback error: ${fallbackErr.message})`));
            }
          }
        } else {
          if (fs.existsSync(tempPath)) {
            try { fs.unlinkSync(tempPath); } catch {}
          }
          reject(new Error(`ffmpeg swap exited with code ${code}. Stderr: ${stderr}`));
        }
      });

      child.on('error', (err) => {
        if (fs.existsSync(tempPath)) {
          try { fs.unlinkSync(tempPath); } catch {}
        }
        reject(err);
      });
    } catch (err) {
      reject(err);
    }
  });
}