import fs from 'node:fs';
const config=JSON.parse(fs.readFileSync('wrangler.jsonc','utf8'));
const id=config.d1_databases?.[0]?.database_id;
if(!id || id==='00000000-0000-0000-0000-000000000000') {
  console.error('실제 D1 데이터베이스를 생성한 뒤 wrangler.jsonc의 database_id를 입력해 주세요. README의 배포 순서를 참고하세요.');
  process.exit(1);
}
if (config.containers || config.services?.some(service => service.binding === 'NLP_SERVICE') || config.limits?.cpu_ms > 10 || !config.migrations?.some(migration => migration.new_sqlite_classes?.includes('ClassroomTasks'))) {
  console.error('Workers Free 구성과 맞지 않습니다. Containers·NLP 바인딩·유료 CPU 설정을 제거하고 SQLite Durable Objects 설정을 확인해 주세요.');
  process.exit(1);
}
console.log('Workers Free 구성·D1 식별자 확인 완료. Secrets와 비공개 R2·Queues 활성화를 확인해 주세요.');
