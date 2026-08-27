import sys, re, os
# PDF.js 3.11.174 (pdf.min.js / pdf.worker.min.js)를 내려받아 둔 폴더
SC = os.environ.get("PDFJS_DIR", "./pdfjs/")
src=open("spine-preview.src.html",encoding="utf-8").read()
# els 참조 감사
ids=set(re.findall(r'\bid="([\w-]+)"', src))
used=set(re.findall(r'\$\("([\w-]+)"\)', src))
missing=sorted(used-ids)
if missing:
    print("!! HTML에 없는 id:", missing); sys.exit(1)
for name,f in (("/*__PDFJS_LIB__*/","pdf.min.js"),("/*__PDFJS_WORKER__*/","pdf.worker.min.js")):
    assert name in src, name
    src=src.replace(name, open(SC+f,encoding="utf-8").read().replace("</script","<\\/script"), 1)
open("spine-preview.html","w",encoding="utf-8").write(src)
open("local.html","w",encoding="utf-8").write(
 "<!doctype html><html lang='ko'><head><meta charset='utf-8'>"
 "<meta name='viewport' content='width=device-width,initial-scale=1'></head><body>"+src+"</body></html>")
print("built %.2f MB · id 감사 통과" % (os.path.getsize("spine-preview.html")/1048576))
