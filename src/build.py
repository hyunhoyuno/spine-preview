import sys, re, os
# PDF.js 3.11.174 (pdf.min.js / pdf.worker.min.js)를 내려받아 둔 폴더
SC = os.environ.get("PDFJS_DIR", "./pdfjs/")

src = open("spine-preview.src.html", encoding="utf-8").read()

# $("id") 로 참조하는데 HTML 에 없는 id 가 있으면 빌드를 막는다
ids  = set(re.findall(r'\bid="([\w-]+)"', src))
used = set(re.findall(r'\$\("([\w-]+)"\)', src))
missing = sorted(used - ids)
if missing:
    print("!! HTML 에 없는 id:", missing); sys.exit(1)

for marker, fn in (("/*__PDFJS_LIB__*/", "pdf.min.js"),
                   ("/*__PDFJS_WORKER__*/", "pdf.worker.min.js")):
    assert marker in src, marker
    code = open(os.path.join(SC, fn), encoding="utf-8").read()
    src = src.replace(marker, code.replace("</script", "<\\/script"), 1)

# 1) 단독 실행용 완전한 문서 (깃허브 페이지 · 로컬 파일 열기)
doc = ("<!doctype html>\n<html lang=\"ko\">\n<head>\n"
       "<meta charset=\"utf-8\">\n"
       "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n"
       "<meta name=\"color-scheme\" content=\"dark\">\n"
       "<meta name=\"description\" content=\"내지 PDF와 제본 사양으로 노출사철제본 책등을 재구성해 미리 보는 도구\">\n"
       + src + "\n</head>\n<body>\n</body>\n</html>\n")
# <title>/<link>/<style> 은 head 로, 나머지는 body 로 가야 한다 → 통째로 body 앞에 두면 브라우저가 정리한다
open("index.html", "w", encoding="utf-8").write(
    "<!doctype html>\n<html lang=\"ko\">\n<head>\n"
    "<meta charset=\"utf-8\">\n"
    "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n"
    "<meta name=\"color-scheme\" content=\"dark\">\n"
    "<meta name=\"description\" content=\"내지 PDF와 제본 사양으로 노출사철제본 책등을 재구성해 미리 보는 도구\">\n"
    "</head>\n<body>\n" + src + "\n</body>\n</html>\n")

# 2) Artifact 게시용 본문 (doctype/html/head/body 없이)
open("spine-preview.html", "w", encoding="utf-8").write(src)

for f in ("index.html", "spine-preview.html"):
    print("%-22s %.2f MB" % (f, os.path.getsize(f) / 1048576))
print("id 감사 통과")
