import { exec } from 'child_process';
import util from 'util';
import path from 'path';

const execPromise = util.promisify(exec);

export interface StorageInfo {
  total: number; // in bytes
  free: number;  // in bytes
  used: number;  // in bytes
}

export async function getStorageSpace(): Promise<StorageInfo> {
  const isWindows = process.platform === 'win32';
  if (isWindows) {
    try {
      const drive = path.parse(process.cwd()).root.substring(0, 2); // e.g. "C:"
      const cmd = `powershell -Command "Get-CimInstance Win32_LogicalDisk -Filter \\"DeviceID = '${drive}'\\" | Select-Object Size, FreeSpace | ConvertTo-Json"`;
      const { stdout } = await execPromise(cmd);
      const data = JSON.parse(stdout.trim());
      const total = Number(data.Size);
      const free = Number(data.FreeSpace);
      if (!isNaN(total) && !isNaN(free)) {
        return { total, free, used: total - free };
      }
    } catch (e) {
      console.error('Failed to get storage space on Windows via powershell ciminstance:', e);
    }

    // Fallback using Get-Volume
    try {
      const driveLetter = path.parse(process.cwd()).root.substring(0, 1); // e.g. "C"
      const cmd = `powershell -Command "Get-Volume -DriveLetter ${driveLetter} | Select-Object Size, SizeRemaining | ConvertTo-Json"`;
      const { stdout } = await execPromise(cmd);
      const data = JSON.parse(stdout.trim());
      const total = Number(data.Size);
      const free = Number(data.SizeRemaining);
      if (!isNaN(total) && !isNaN(free)) {
        return { total, free, used: total - free };
      }
    } catch (e) {
      console.error('Failed to get storage space on Windows via powershell volume:', e);
    }
  } else {
    // Linux/macOS
    try {
      const { stdout } = await execPromise(`df -B1 "${process.cwd()}"`);
      const lines = stdout.trim().split('\n');
      if (lines.length >= 2) {
        const parts = lines[1].split(/\s+/);
        // df output format:
        // Filesystem     1B-blocks      Used Available Use% Mounted on
        // /dev/sda1      total          used  available  ...
        const total = parseInt(parts[1], 10);
        const used = parseInt(parts[2], 10);
        const free = parseInt(parts[3], 10);
        if (!isNaN(total) && !isNaN(free)) {
          return { total, free, used };
        }
      }
    } catch (e) {
      console.error('Failed to get storage space on Linux via df:', e);
    }
  }

  // Safe fallback values
  return { total: 0, free: 0, used: 0 };
}
