import Papa from 'papaparse';
import { identitySchema } from '../shared/contracts';

export const HEADERS = ['학년', '반', '번호', '이름', '비밀번호'];
export type RosterRow = { grade: number; classNumber: number; studentNumber: number; name: string; password?: string };
export function validateRows(rows: unknown[][]): RosterRow[] {
  if (!rows.length || HEADERS.some((h, i) => String(rows[0][i] ?? '').replace(/^\uFEFF/, '').trim() !== h)) throw new Error('첫 행은 학년, 반, 번호, 이름, 비밀번호 순서여야 합니다. 제공된 양식을 이용해 주세요.');
  const records: RosterRow[] = []; const keys = new Set<string>();
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i]; if (row.every((v) => v === '' || v === null || v === undefined)) continue;
    const input = identitySchema.safeParse({ grade: row[0], classNumber: row[1], studentNumber: row[2], name: String(row[3] ?? '').trim() });
    if (!input.success) throw new Error(`${i + 1}행: 학년·반·번호·이름을 확인해 주세요.`);
    const password = row[4] === null || row[4] === undefined || row[4] === '' ? undefined : String(row[4]);
    if (password && (password.length < 6 || password.length > 128)) throw new Error(`${i + 1}행: 비밀번호는 6~128자여야 합니다.`);
    const key = `${input.data.grade}:${input.data.classNumber}:${input.data.studentNumber}`;
    if (keys.has(key)) throw new Error(`${i + 1}행: 학년·반·번호가 중복되었습니다.`);
    keys.add(key); records.push({ ...input.data, ...(password ? { password } : {}) });
  }
  if (!records.length || records.length > 300) throw new Error('한 파일에 1~300명의 학생을 입력해 주세요.');
  return records;
}
export async function readRoster(file: File) {
  if (file.size > 2 * 1024 * 1024) throw new Error('2MB 이하의 명단 파일을 사용해 주세요.');
  if (/\.csv$/i.test(file.name)) {
    const text = await file.text();
    if (text.includes('\uFFFD')) throw new Error('CSV를 UTF-8 형식으로 저장해 주세요.');
    const parsed = Papa.parse<string[]>(text, { skipEmptyLines: 'greedy' });
    if (parsed.errors.length) throw new Error('CSV 형식이 올바르지 않습니다.');
    return validateRows(parsed.data);
  }
  if (!/\.xlsx$/i.test(file.name)) throw new Error('.xlsx 또는 UTF-8 .csv 파일을 사용해 주세요.');
  const ExcelJS = await import('exceljs');
  const workbook = new ExcelJS.default.Workbook(); await workbook.xlsx.load(await normalizeXlsx(await file.arrayBuffer()));
  const sheet = workbook.getWorksheet('학생명단') || workbook.worksheets[0];
  if (!sheet || sheet.rowCount > 1000) throw new Error('학생명단 시트와 행 수를 확인해 주세요.');
  const rows: unknown[][] = [];
  sheet.eachRow({ includeEmpty: true }, (row) => {
    const values = HEADERS.map((_, index) => {
      const cell = row.getCell(index + 1);
      if (cell.type === ExcelJS.default.ValueType.Formula) throw new Error(`${row.number}행: 수식 대신 값을 입력해 주세요.`);
      return cell.text;
    }); rows.push(values);
  });
  return validateRows(rows);
}
// ExcelJS assumes an unprefixed SpreadsheetML root. Valid workbooks from other
// producers can use x:workbook. Normalize only that namespace, preserving values.
export async function normalizeXlsx(buffer: ArrayBuffer) {
  const {default: JSZip} = await import('jszip');
  const zip = await JSZip.loadAsync(buffer);
  let changed = false;
  let expanded = 0;
  for (const entry of Object.values(zip.files)) {
    if (entry.dir || !entry.name.endsWith('.xml')) continue;
    let text = await entry.async('string'); expanded += text.length;
    if (expanded > 10_000_000) throw new Error('명단 파일의 내용이 너무 큽니다. 필요한 명단 시트만 남겨 주세요.');
    const prefix = text.match(/xmlns:([A-Za-z_]\w*)="http:\/\/schemas\.openxmlformats\.org\/spreadsheetml\/2006\/main"/)?.[1];
    if (!prefix) continue;
    text = text.replace(new RegExp('(<\\/?)(?:'+prefix+'):','g'),'$1').replace('xmlns:'+prefix+'="http://schemas.openxmlformats.org/spreadsheetml/2006/main"','xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"');
    zip.file(entry.name,text); changed = true;
  }
  return changed ? await zip.generateAsync({type:'arraybuffer'}) : buffer;
}
export function credentialsCsv(rows: {grade:number;classNumber:number;studentNumber:number;name:string;password:string}[]) {
  const safe = (value: string | number) => { const s = String(value); return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s; };
  return '\uFEFF' + Papa.unparse([HEADERS, ...rows.map((r) => [r.grade, r.classNumber, r.studentNumber, r.name, r.password].map(safe))]);
}
