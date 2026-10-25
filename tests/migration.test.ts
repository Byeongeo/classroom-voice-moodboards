import{Miniflare,convertV4MiniflareOptions}from'miniflare';
import{readFileSync}from'node:fs';
import{expect,it}from'vitest';
it('기존 클래스에 활동이 있는 데이터베이스도 기록과 외래 키를 보존하여 확장한다',async()=>{
  const storage=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("migration");}}',compatibilityDate:'2026-10-19',d1Databases:['DB']}));
  try{const db=await storage.getD1Database('DB');
    const statements=(file:string)=>readFileSync('migrations/'+file,'utf8').split(';').map(s=>s.trim()).filter(Boolean).map(s=>db.prepare(s));
    await db.batch(statements('0001_classroom.sql'));await db.batch(statements('0002_backup_retry.sql'));
    await db.prepare("INSERT INTO classes(id,name,grade,class_number)VALUES('legacy-class','기존 수업',5,2)").run();
    await db.prepare("INSERT INTO activities(id,class_id,title,unit,opens_at,closes_at,rubric_json,created_at)VALUES('legacy-activity','legacy-class','기존 활동','1단원',1,9999999999999,'[]',1)").run();
    await db.batch(statements('0003_participants_and_image_history.sql'));
    await db.batch(statements('0004_activity_participants.sql'));
    expect((await db.prepare("SELECT assignment_mode FROM activities WHERE id='legacy-activity'").first<any>()).assignment_mode).toBe('class');
    expect((await db.prepare('SELECT * FROM activity_rooms').all()).results).toEqual([]);
    expect((await db.prepare("SELECT title FROM activities WHERE id='legacy-activity'").first<any>()).title).toBe('기존 활동');
    expect(await db.prepare('PRAGMA foreign_key_check').all()).toMatchObject({results:[]});
    expect((await db.prepare("SELECT grade,class_number FROM class_rooms WHERE class_id='legacy-class'").first())).toEqual({grade:5,class_number:2});
    await db.prepare("INSERT INTO classes(id,name,grade,class_number)VALUES('second-class','다른 수업',5,2)").run();
  }finally{await storage.dispose();}
});
