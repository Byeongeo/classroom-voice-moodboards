import { z } from 'zod';

export const MODELS = {
  intent: 'openai/gpt-4.1-mini',
  image: 'openai/gpt-image-2',
  analysis: 'openai/gpt-4.1',
} as const;
export const ANALYSIS_VERSION = 'ko-openrouter-rubric-v3';
export const rubricSchema = z.array(z.object({ id: z.string().min(1).max(60), label: z.string().trim().min(1).max(50), description: z.string().trim().min(1).max(500) })).max(8).refine((r) => new Set(r.map((c) => c.id)).size === r.length, '평가 기준 ID가 중복되었습니다.');
export const DEFAULT_RUBRIC = [
  { id: 'subject', label: '대상의 구체성', description: '무엇을 묘사하는지 대상과 특징을 분명히 드러낸다.' },
  { id: 'attributes', label: '감각적 속성', description: '색, 모양, 질감 등 감각적 속성을 구체적으로 표현한다.' },
  { id: 'relations', label: '관계와 맥락', description: '공간, 시간, 원인, 비교 관계를 분명히 표현한다.' },
  { id: 'quantity', label: '수량과 정도', description: '수량, 크기, 정도를 구별 가능하게 표현한다.' },
];
export type Rubric = z.infer<typeof rubricSchema>;
export const SCORE_LEVELS = [
  { score: 0, label: '근거 없음', description: '현재 발화에 이 기준을 판단할 표현이 없습니다. 다음·삭제 같은 관리 명령도 0점입니다.' },
  { score: 1, label: '막연한 표현', description: '대상이나 특징을 짐작할 수 있지만 무엇인지 구별하기에는 모호합니다.' },
  { score: 2, label: '명시된 단서', description: '해당 기준에 맞는 구체적인 단서가 한 가지 분명하게 나타납니다.' },
  { score: 3, label: '여러 구체적 단서', description: '관련된 여러 특징이나 관계를 명시하여 장면을 자세히 구별할 수 있습니다.' },
  { score: 4, label: '정밀하게 구별되는 표현', description: '대상을 다른 대상과 구별할 수 있는 정밀하고 일관된 단서가 충분합니다.' },
] as const;
export const RUBRIC_EXAMPLES: Record<string, string[]> = {
  subject: ['대상 언급 없음', '무언가를 그려 줘', '고양이를 그려 줘', '우산을 든 어린 고양이를 그려 줘', '왼쪽 귀 끝이 접힌 줄무늬 아기 고양이를 그려 줘'],
  attributes: ['속성 표현 없음', '예쁘게 해 줘', '빨간 꽃', '붉은 꽃잎과 노란 꽃술, 매끈한 잎', '빛이 비치는 얇은 붉은 꽃잎과 거친 잎맥을 구별해 표현해 줘'],
  relations: ['관계 표현 없음', '어딘가에 있어', '고양이 오른쪽에 꽃이 있어', '고양이 오른쪽 꽃 뒤에 낮은 담장이 있어', '화면 왼쪽 앞의 고양이보다 한 걸음 뒤, 담장 아래에 꽃이 줄지어 있어'],
  quantity: ['수량·정도 표현 없음', '많이 그려 줘', '꽃 세 송이', '큰 꽃 한 송이와 작은 꽃 두 송이', '같은 간격으로 세 송이를 놓고, 가운데 꽃을 양옆 꽃보다 두 배 크게 그려 줘'],
};

export const identitySchema = z.object({
  grade: z.coerce.number().int().min(1).max(12),
  classNumber: z.coerce.number().int().min(1).max(50),
  studentNumber: z.coerce.number().int().min(1).max(100),
  name: z.string().trim().min(1).max(30),
});
export const loginSchema = identitySchema.extend({ password: z.string().min(6).max(128) });
export const rosterSchema = z.object({ students: z.array(identitySchema.extend({
  password: z.string().min(6).max(128).optional(),
  commandLimit: z.number().int().min(0).max(200).default(10),
})).min(1).max(25) });
export const commandSchema = z.object({
  requestId: z.string().uuid(),
  transcript: z.string().trim().min(1).max(1500),
  inputMethod: z.enum(['speech', 'text']),
  styleId: z.string().min(1).max(60),
  recognizedText: z.string().max(1500).nullable().optional(),
});
export const intentSchema = z.object({
  action: z.enum(['START_NEW_THEME', 'EDIT_ACTIVE', 'SAVE_AND_NEXT', 'DISCARD_ACTIVE', 'IGNORE']),
  themeTitle: z.string().max(80).nullable(),
  imagePrompt: z.string().max(2000).nullable(),
});

const evidence = z.object({ quote: z.string().min(1).max(300), explanation: z.string().min(1).max(500) });
export const semanticSchema = z.object({
  interpretation: z.string().min(1).max(800),
  specificity: z.object({
    subject: z.number().int().min(0).max(4),
    attributes: z.number().int().min(0).max(4),
    relations: z.number().int().min(0).max(4),
    quantity: z.number().int().min(0).max(4),
    evidence: z.array(evidence).max(8),
  }),
  irony: z.object({ label: z.enum(['likely', 'unlikely', 'uncertain']), evidence: z.array(evidence).max(4) }),
  negation: z.object({
    label: z.enum(['none', 'single', 'double', 'uncertain']),
    resolvedMeaning: z.string().max(600), evidence: z.array(evidence).max(4),
  }),
  needsReview: z.boolean(),
  rubricScores: z.array(z.object({ id: z.string(), score: z.number().int().min(0).max(4), reason:z.string().min(1).max(500).optional(), evidence: z.array(evidence).max(4) })).max(8),
});
export type SemanticAnalysis = z.infer<typeof semanticSchema>;
export type Student = {
  id: string; grade: number; class_number: number; student_number: number; name: string;
  command_limit: number; quota_reset_at: number; enabled: number; current_board_id: string | null;
};
export type Board = { id: string; activity_id: string; title: string; active_image_id: string | null; created_at: number };
const roomSchema = z.object({ grade: z.number().int().min(1).max(12), classNumber: z.number().int().min(1).max(50) });
export const classSchema = z.object({ name: z.string().trim().min(1).max(80), grade: z.number().int().min(1).max(12).optional(), classNumber: z.number().int().min(1).max(50).optional(), rooms: z.array(roomSchema).max(100).optional() }).refine(v => (v.grade === undefined) === (v.classNumber === undefined), '학년과 반을 함께 지정해 주세요.');
export const assignmentSchema = z.object({
  rooms: z.array(roomSchema).max(100),
  students: z.array(z.object({ studentId: z.string().uuid(), access: z.boolean() })).max(500),
}).refine(v => new Set(v.rooms.map(r => `${r.grade}:${r.classNumber}`)).size === v.rooms.length && new Set(v.students.map(s => s.studentId)).size === v.students.length, '참여 대상이 중복되었습니다.');
export type ClassRoom = { class_id: string; grade: number; class_number: number };
export type ClassStudent = { class_id: string; student_id: string; access: number };
export type AssignmentTargets = z.infer<typeof assignmentSchema>;
export const activityAssignmentSchema = assignmentSchema.and(z.object({ mode: z.enum(['class', 'custom']) }));
export type ActivityAssignment = z.infer<typeof activityAssignmentSchema>;
export type ActivityRoom = { activity_id: string; grade: number; class_number: number };
export type ActivityParticipant = { activity_id: string; student_id: string; access: number };
export const genreSchema = z.object({ name: z.string().trim().min(1).max(20), description: z.string().trim().max(300).default(''), recommendedStyleId: z.string().max(60).nullable().default(null) });
export type WritingGenre = { id: string; name: string; description: string; recommended_style_id: string | null; enabled: number };
export const activitySchema = z.object({
  classId: z.string().uuid(), title: z.string().trim().min(1).max(100), unit: z.string().trim().min(1).max(100),
  instructions: z.string().max(2000).default(''), opensAt: z.number().int().positive(), closesAt: z.number().int().positive(),
  commandLimit: z.number().int().min(0).max(200),
  rubric: rubricSchema.default(DEFAULT_RUBRIC),
  assignment: activityAssignmentSchema.optional(),
}).refine((v) => v.closesAt > v.opensAt, '종료 시각은 시작 시각 이후여야 합니다.');
export type Classroom = { id: string; name: string; grade: number | null; class_number: number | null; deleted_at: number | null };
export type ImageStyle = { id: string; name: string; prompt: string; genres_json: string; enabled: number };
export type Activity = { id: string; class_id: string; title: string; unit: string; instructions: string; opens_at: number; closes_at: number; command_limit: number; rubric_json: string; deleted_at: number | null; class_name?: string; assignment_mode?: 'class' | 'custom' };
export type SavedImage = {
  id: string; event_id: string; board_id: string; prompt: string; mime_type: string;
  parent_image_id: string | null; on_board: number; hidden_at: number | null; origin: 'generated' | 'upload'; byte_size:number; created_at: number; imageUrl: string;
};
export type EventRecord = {
  id: string; student_id: string; board_id: string; activity_id: string; transcript: string; input_method: 'speech' | 'text';
  status: string; action: string | null; prompt: string | null; image_id: string | null;
  error_code: string | null; analysis_status: string; analysis_json: string | null; created_at: number;
  review_note?: string | null;
  kind: 'command' | 'upload';
};
export type ImageAction = { id: string; image_id: string; event_id: string | null; action: 'upload'|'generate'|'edit'|'hide'|'pin'|'activate'|'discard'; metadata_json: string; created_at: number; student_id: string; board_id: string; activity_id: string };
export const IMAGE_ACTION_NAMES: Record<ImageAction['action'], string> = {upload:'이미지 업로드',generate:'이미지 생성',edit:'이미지 수정',hide:'화면에서 제거',pin:'보드에 보관',activate:'작업 이미지로 불러오기',discard:'발화로 이미지 닫기'};
export type Workspace = {
  student: Student; used: number; limit: number; activity: Activity; board: Board;
  images: SavedImage[]; events: EventRecord[]; pending: EventRecord | null;
};
export type Morphology = {
  engine: string; version: string; tokens: { form: string; tag: string; start: number; len: number; lemma?: string; head?: number; relation?: string; sentence?: number }[];
  metrics: { contentWords: number; uniqueContentWords: number; lexicalDiversity: number; modifiers: number; negationMarkers: number };
  keywords: { word: string; count: number }[];
};
export const languageSchema = z.object({
  keywords: z.array(z.string().trim().min(1).max(60)).max(20),
  expressions: z.array(z.object({
    quote: z.string().min(1).max(300),
    category: z.enum(['subject', 'attributes', 'relations', 'quantity', 'negation']),
    explanation: z.string().min(1).max(300),
  })).max(12),
});
export type LanguageFeatures = {
  engine: 'openrouter-ko-evidence';
  keywords: { word: string; count: number }[];
  expressions: z.infer<typeof languageSchema>['expressions'];
};
// Optional morphology keeps previously stored Stanza observations readable.
export type Analysis = { language?: LanguageFeatures; morphology?: Morphology; semantic: SemanticAnalysis; score: number | null; rubric: Rubric; version: string; model: string };
