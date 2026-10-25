export type BackupFile = { name: string; bytes: number; url: string };
export function splitBackupFiles(files: BackupFile[], limit = 80 * 1024 * 1024) {
  const parts: BackupFile[][] = [];
  let part: BackupFile[] = [], bytes = 0;
  for (const file of files) {
    if (file.bytes > limit) throw new Error('개별 백업 파일이 다운로드 한도를 넘었습니다.');
    if (part.length && bytes + file.bytes > limit) {parts.push(part);part=[];bytes=0;}
    part.push(file);bytes+=file.bytes;
  }
  if (part.length) parts.push(part);
  return parts;
}
