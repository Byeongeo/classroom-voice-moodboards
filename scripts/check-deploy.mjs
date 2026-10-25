import fs from 'node:fs';
const config=JSON.parse(fs.readFileSync('wrangler.jsonc','utf8'));
const id=config.d1_databases?.[0]?.database_id;
if(!id || id==='00000000-0000-0000-0000-000000000000') {
  console.error('실제 D1 데이터베이스를 생성한 뒤 wrangler.jsonc의 database_id를 입력해 주세요. README의 배포 순서를 참고하세요.');
  process.exit(1);
}
console.log('D1 식별자 확인 완료. 원격 Secrets와 R2/Queues/NLP 서비스 준비도 확인해 주세요.');
