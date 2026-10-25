import importlib.util
import json
import sys
import time
from pathlib import Path

root = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("korean_nlp", root / "nlp-worker" / "app.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
cases = [
    "빨간 꽃 세 송이를 작은 유리병 안에 꽂아 줘.",
    "예쁘지 않은 것은 아니다.",
    "안 갈 수 없다.",
    "안 예쁜 꽃은 싫어.",
    "참 잘했네.",
    "꽃은 빨갛지 않고 노랗게 해 줘.",
    "구름 한 점 없는 파란 하늘 아래, 키 큰 소나무 두 그루를 그려 줘.",
    "다음",
]
outputs = []
for text in cases:
    start = time.perf_counter()
    result = module.analyze_text(text)
    assert result["tokens"] and all("head" in token and "relation" in token for token in result["tokens"])
    outputs.append({"text": text, "latencyMs": round((time.perf_counter() - start) * 1000), **result})
target = root / "output" / "nlp-verification.json"
target.write_text(json.dumps({"engine":"stanza-ko-gsd","cases":outputs,"scope":"실제 구문 분석 검증. 반어/이중 부정 의미 분류의 정답률 검증은 아님."}, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps({"cases":len(outputs),"meanMs":round(sum(v["latencyMs"] for v in outputs)/len(outputs)),"output":str(target)}, ensure_ascii=False))
