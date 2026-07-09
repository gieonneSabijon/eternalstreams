import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export async function GET() {
  const logFilePath = path.join(process.cwd(), 'ffmpeg_log.txt');
  try {
    if (!fs.existsSync(logFilePath)) {
      return NextResponse.json({ logs: 'No stream activity logs found. Start broadcasting to initiate logging.' });
    }
    const data = fs.readFileSync(logFilePath, 'utf-8');
    const lines = data.split('\n');
    // Return last 150 lines of logs for viewing
    const lastLines = lines.slice(-150).join('\n');
    return NextResponse.json({ logs: lastLines });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || 'Failed to read log file' }, { status: 500 });
  }
}
