import { exec, spawn } from 'child_process';
import util from 'util';
import fs from 'fs';
import path from 'path';
// @ts-ignore
import ffmpegPathRaw from 'ffmpeg-static';

const execPromise = util.promisify(exec);

export interface VideoConfig {
  width: number;
  height: number;
  fps: number;
  sampleRate: number;
  channels: number;
  tbn: number;
}

export function getCleanedFfmpegPath(): string {
  let ffmpegPath = ffmpegPathRaw || 'ffmpeg';
  if (ffmpegPathRaw) {
    const cleaned = ffmpegPathRaw.replace(/^\\ROOT|^ROOT|^\/ROOT/i, '');
    const relativePath = cleaned.startsWith('/') || cleaned.startsWith('\\') ? cleaned.slice(1) : cleaned;
    ffmpegPath = path.resolve(process.cwd(), relativePath);
  }
  return ffmpegPath;
}

export function getVideoConfig(filePath: string, ffmpegPath: string): Promise<VideoConfig> {
  return new Promise((resolve, reject) => {
    exec(`"${ffmpegPath}" -i "${filePath}"`, (err, stdout, stderr) => {
      const output = stderr || '';
      
      // Match resolution (e.g. 640x480 or 1920x1080)
      const resMatch = output.match(/,\s*(\d{3,5})x(\d{3,5})/);
      const width = resMatch ? parseInt(resMatch[1], 10) : null;
      const height = resMatch ? parseInt(resMatch[2], 10) : null;
      
      // Match framerate (e.g. 30 fps, 59.94 fps, 25 fps)
      const fpsMatch = output.match(/,\s*(\d+(?:\.\d+)?)\s*fps/);
      const fps = fpsMatch ? parseFloat(fpsMatch[1]) : 30; // fallback to 30
      
      // Match audio sample rate (e.g. 44100 Hz, 48000 Hz)
      const arMatch = output.match(/,\s*(\d+)\s*Hz/);
      const sampleRate = arMatch ? parseInt(arMatch[1], 10) : 44100; // fallback to 44100
      
      // Match audio channels
      let channels = 2; // default stereo
      if (output.includes('mono')) {
        channels = 1;
      } else if (output.includes('stereo')) {
        channels = 2;
      } else {
        const chanMatch = output.match(/,\s*(\d+)\s*channels/);
        if (chanMatch) {
          channels = parseInt(chanMatch[1], 10);
        }
      }
      
      // Match tbn (timebase)
      const tbnMatch = output.match(/,\s*(\d+(?:\.\d+)?[kK]?)\s*tbn/);
      let tbn = 90000;
      if (tbnMatch) {
        const valStr = tbnMatch[1].toLowerCase();
        if (valStr.endsWith('k')) {
          tbn = Math.round(parseFloat(valStr.slice(0, -1)) * 1000);
        } else {
          tbn = Math.round(parseFloat(valStr));
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
          tbn
        });
      }
    });
  });
}

export async function isNormalized(filePath: string, target: VideoConfig, ffmpegPath: string): Promise<boolean> {
  try {
    const current = await getVideoConfig(filePath, ffmpegPath);
    // Compare current with target config.
    // Allow slight tolerance in fps floating point comparison (e.g., 29.97 vs 30)
    const fpsMatch = Math.abs(current.fps - target.fps) < 0.5;
    return (
      current.width === target.width &&
      current.height === target.height &&
      fpsMatch &&
      current.sampleRate === target.sampleRate &&
      current.channels === target.channels &&
      current.tbn === target.tbn
    );
  } catch (err) {
    console.error(`Error checking normalization for ${filePath}:`, err);
    return false;
  }
}

export function normalizeVideo(
  filePath: string,
  tempPath: string,
  target: VideoConfig,
  ffmpegPath: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const scaleFilter = `scale=${target.width}:${target.height}:force_original_aspect_ratio=decrease,pad=${target.width}:${target.height}:(ow-iw)/2:(oh-ih)/2,setsar=1`;
    const args = [
      '-y',
      '-i', filePath,
      '-vf', scaleFilter,
      '-r', target.fps.toString(),
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-b:v', '2500k',
      '-maxrate', '2500k',
      '-bufsize', '5000k',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-ar', target.sampleRate.toString(),
      '-ac', target.channels.toString(),
      '-video_track_timescale', target.tbn.toString(),
      tempPath
    ];

    const child = spawn(ffmpegPath, args);
    let stderr = '';
    
    child.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`ffmpeg exited with code ${code}. Stderr: ${stderr}`));
      }
    });

    child.on('error', (err) => {
      reject(err);
    });
  });
}
