import type { Activity, ActivityParticipant, ActivityRoom, AssignmentTargets, ClassRoom, ClassStudent, Student } from '../shared/contracts';

export function classTargets(rooms: ClassRoom[], students: ClassStudent[]): AssignmentTargets {
  return { rooms: rooms.map(room => ({ grade: room.grade, classNumber: room.class_number })), students: students.map(student => ({ studentId: student.student_id, access: !!student.access })) };
}
export function activityTargets(activity: Activity, defaults: AssignmentTargets, rooms: ActivityRoom[], students: ActivityParticipant[]): AssignmentTargets {
  if (activity.assignment_mode !== 'custom') return defaults;
  return { rooms: rooms.filter(room => room.activity_id === activity.id).map(room => ({ grade: room.grade, classNumber: room.class_number })), students: students.filter(student => student.activity_id === activity.id).map(student => ({ studentId: student.student_id, access: !!student.access })) };
}
export function selectedStudents(students: Student[], targets: AssignmentTargets) {
  const exceptions = new Map(targets.students.map(student => [student.studentId, student.access]));
  return students.filter(student => student.enabled && (exceptions.get(student.id) ?? targets.rooms.some(room => room.grade === student.grade && room.classNumber === student.class_number)));
}
export function audienceDescription(targets: AssignmentTargets) {
  return [...targets.rooms.map(room => `${room.grade}학년 ${room.classNumber}반`),
    ...(targets.students.some(student => student.access) ? [`개별 추가 ${targets.students.filter(student => student.access).length}명`] : []),
    ...(targets.students.some(student => !student.access) ? [`개별 제외 ${targets.students.filter(student => !student.access).length}명`] : []),
  ].join(' · ') || '참여 대상 미배정';
}
