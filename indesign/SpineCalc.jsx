/*
 * SpineCalc v2.2 — 노출사철제본 책등 계산기 (Adobe InDesign / ExtendScript)
 * =====================================================================
 * MVP 기능
 *   1) 용지(종류·평량) → 낱장 두께 자동 산출 / 직접 입력
 *   2) 총 페이지 + 대수 구성 → 등 노출 페이지·대수별 두께·책등 총 두께
 *   3) 페이지에서 등면으로 넘어가 보이는 안쪽 여백(mm) 산출
 *   4) 등면 도해: 책등 아트워크 캔버스 문서 생성 (대수 가이드 + 라벨 + 방향 표시)
 *   5) 현재 문서에 노출영역 가이드 + 본문 안전영역 침범 경고
 *   6) 책등 이미지 대수 단위 자동 분할·배치 (가변 폭, 접지 방향 반전)
 *   7) 리포트(TXT/CSV) + 배치 좌표(JSON) 내보내기
 *   8) 더미북 실측값 → 계수 역산 보정 루프
 *
 * 설치: InDesign > 창 > 유틸리티 > 스크립트 > User > Scripts Panel 폴더에 넣고 더블클릭
 */

#target indesign
#targetengine "session"

/*
 * 창은 반드시 palette 여야 한다.
 * ScriptUI "dialog"는 모달이라, 떠 있는 동안 InDesign이 문서 생성·수정과
 * scriptPreferences 변경을 전부 거부한다
 * ("다른 대화 상자 또는 경고가 활성화되어 있으므로 요청을 처리할 수 없습니다").
 * palette는 비모달이라 실행 버튼이 정상 동작하며,
 * 창이 살아 있으려면 #targetengine "session" 과 전역 참조가 함께 필요하다.
 */

(function () {

// ═════════════════════════════════════════════════════════════
// 용지 데이터베이스
//   caliper(mm) = 평량(g/m²) × 부피(bulk) ÷ 1000
//   ※ 유통 공칭 스펙 기반 추정치. 반드시 더미북 실측으로 보정할 것.
// ═════════════════════════════════════════════════════════════
var PAPERS = [
    { name: "모조지 (백상지)",           bulk: 1.15, gsm: [70, 80, 100, 120, 150, 180] },
    { name: "미색모조",                  bulk: 1.30, gsm: [70, 80, 100, 120, 150] },
    { name: "스노우화이트지 (스노우지)", bulk: 0.95, gsm: [100, 120, 150, 180, 200, 250] },
    { name: "아트지",                    bulk: 0.83, gsm: [100, 120, 150, 180, 200, 250] },
    { name: "인스퍼 M",                  bulk: 1.50, gsm: [105, 130, 160, 190, 210] },
    { name: "인스퍼 에코",               bulk: 1.45, gsm: [100, 120, 150, 180] },
    { name: "랑데뷰 울트라화이트",       bulk: 1.22, gsm: [105, 130, 160, 190, 240] },
    { name: "몽블랑",                    bulk: 1.45, gsm: [100, 120, 150, 180] },
    { name: "그린라이트",                bulk: 1.55, gsm: [80, 100, 120, 150] },
    { name: "문켄 폴라",                 bulk: 1.40, gsm: [90, 100, 120, 150] },
    { name: "반누보",                    bulk: 1.25, gsm: [105, 130, 160, 190] },
    { name: "아르떼",                    bulk: 1.55, gsm: [90, 105, 130, 160] },
    { name: "매쉬멜로우",                bulk: 1.30, gsm: [105, 130, 160, 190] },
    { name: "띤또레또",                  bulk: 1.35, gsm: [105, 130, 160] },
    { name: "직접 입력",                 bulk: 0,    gsm: [0] }
];

var LAYER_GUIDE = "책등 노출영역";
var LAYER_ART   = "책등 아트워크";

// ═════════════════════════════════════════════════════════════
// 설정 저장소
//   ~/Library/Application Support/SpineCalc/settings.ini
//   [last]      = 마지막으로 쓴 값 (창을 닫아도 유지)
//   [preset:이름] = 사용자가 저장한 프리셋
//   ExtendScript에는 JSON이 없어 key=value 줄 형식을 쓴다. 직접 열어 편집해도 된다.
// ═════════════════════════════════════════════════════════════

function storeFile() {
    var dir = new Folder(Folder.userData.fsName + "/SpineCalc");
    if (!dir.exists) { dir.create(); }
    return new File(dir.fsName + "/settings.ini");
}

function readStore() {
    var st = { last: null, presets: {}, order: [] };
    var f = storeFile();
    if (!f.exists) return st;
    f.encoding = "UTF-8";
    if (!f.open("r")) return st;
    var txt = f.read();
    f.close();
    txt = String(txt).replace(/^\uFEFF/, "");
    var lines = txt.split(/\r\n|\r|\n/);
    var cur = null, i, L, m, nm, eq;
    for (i = 0; i < lines.length; i++) {
        L = lines[i];
        if (!L || L.charAt(0) === ";") continue;
        m = L.match(/^\[(.*)\]$/);
        if (m) {
            cur = {};
            nm = m[1];
            if (nm === "last") { st.last = cur; }
            else if (nm.substring(0, 7) === "preset:") {
                nm = nm.substring(7);
                if (!st.presets[nm]) { st.order.push(nm); }
                st.presets[nm] = cur;
            } else { cur = null; }
            continue;
        }
        if (!cur) continue;
        eq = L.indexOf("=");
        if (eq < 0) continue;
        cur[L.substring(0, eq)] = L.substring(eq + 1);
    }
    return st;
}

function kvLines(o) {
    var a = [], k;
    for (k in o) {
        if (o.hasOwnProperty(k)) {
            a.push(k + "=" + String(o[k]).replace(/[\r\n]/g, " "));
        }
    }
    return a.join("\n");
}

function writeStore(st) {
    var out = [], i, nm;
    out.push("; SpineCalc 설정 파일 — 직접 편집해도 됩니다");
    if (st.last) { out.push("[last]"); out.push(kvLines(st.last)); }
    for (i = 0; i < st.order.length; i++) {
        nm = st.order[i];
        if (!st.presets[nm]) continue;
        out.push("[preset:" + nm + "]");
        out.push(kvLines(st.presets[nm]));
    }
    var f = storeFile();
    f.encoding = "UTF-8";
    f.lineFeed = "Unix";
    if (!f.open("w")) return false;
    f.write(out.join("\n") + "\n");
    f.close();
    return true;
}

function cleanPresetName(nm) {
    return String(nm).replace(/[\[\]\r\n]/g, "").replace(/^\s+|\s+$/g, "");
}

// ═════════════════════════════════════════════════════════════
// 계산 코어 (InDesign API 비의존)
// ═════════════════════════════════════════════════════════════

function paperThickness(paperIdx, gsm) {
    var p = PAPERS[paperIdx];
    if (!p || p.bulk === 0) return 0;
    return gsm * p.bulk / 1000;
}

/* 총 페이지 수 → 대수 목록. 나머지는 8p/4p 단위로 뒤에 편성 */
function composeSignatures(totalPages, sigSize) {
    if (totalPages % 4 !== 0) return null;
    var out = [], remain = totalPages;
    while (remain >= sigSize) { out.push(sigSize); remain -= sigSize; }
    while (remain >= 8) { out.push(8); remain -= 8; }
    if (remain > 0) out.push(remain);
    return out;
}

/* "16,16,8" 파싱 */
function parseManualSignatures(str) {
    var parts = String(str).split(/[,\s]+/), out = [], i, v;
    for (i = 0; i < parts.length; i++) {
        if (parts[i] === "") continue;
        v = parseInt(parts[i], 10);
        if (isNaN(v) || v <= 0 || v % 4 !== 0) return null;
        out.push(v);
    }
    return out.length ? out : null;
}

/*
 * 대수 배열 → 등면 좌표계
 *   x0/x1 : 책등 위 밴드 시작/끝 (mm). 0 = 앞표지쪽
 *   mid   : 접지 중심 = 첫 쪽 / 마지막 쪽 분기선
 *   first : 대수 첫 쪽 (홀수·recto, 등은 페이지 왼쪽)
 *   last  : 대수 마지막 쪽 (짝수·verso, 등은 페이지 오른쪽)
 *   wrapW : 그 페이지에서 등면으로 넘어가 보이는 안쪽 여백 폭 (mm)
 */
function buildSpine(sigs, caliper, threadMM, gapMM, curvature) {
    var rows = [], x = 0, pageNo = 1, i, minW = 1e9, maxW = 0;
    for (i = 0; i < sigs.length; i++) {
        var pages  = sigs[i];
        var leaves = pages / 2;
        var t      = leaves * caliper + threadMM;
        var w      = (t / 2) * curvature;
        if (w < minW) minW = w;
        if (w > maxW) maxW = w;
        rows.push({
            no: i + 1, pages: pages, leaves: leaves,
            first: pageNo, last: pageNo + pages - 1,
            thick: t, x0: x, x1: x + t, mid: x + t / 2, wrapW: w
        });
        x += t + gapMM;
        pageNo += pages;
    }
    return {
        rows: rows,
        totalSpine: (sigs.length ? x - gapMM : 0),
        minWrap: (sigs.length ? minW : 0),
        maxWrap: maxW
    };
}

function fx(n, d) {
    if (d === undefined) d = 3;
    if (isNaN(n)) return "-";
    var s = (Math.round(n * Math.pow(10, d)) / Math.pow(10, d)).toFixed(d);
    return s;
}

// ═════════════════════════════════════════════════════════════
// 환경 저장/복원  (중첩 호출 안전 — 스택 방식)
// ═════════════════════════════════════════════════════════════
var envStack = [];

function pushEnv(doc) {
    var e = {
        unit: app.scriptPreferences.measurementUnit,
        uil:  app.scriptPreferences.userInteractionLevel,
        doc:  null, origin: null
    };
    app.scriptPreferences.measurementUnit = MeasurementUnits.MILLIMETERS;
    app.scriptPreferences.userInteractionLevel = UserInteractionLevels.NEVER_INTERACT;
    if (doc && doc.isValid) {
        e.doc = doc;
        e.origin = doc.viewPreferences.rulerOrigin;
        doc.viewPreferences.rulerOrigin = RulerOrigin.SPREAD_ORIGIN;
    }
    envStack.push(e);
}

function popEnv() {
    if (!envStack.length) return;
    var e = envStack.pop();
    if (e.doc && e.doc.isValid) {
        try { e.doc.viewPreferences.rulerOrigin = e.origin; } catch (err) {}
    }
    app.scriptPreferences.measurementUnit = e.unit;
    app.scriptPreferences.userInteractionLevel = e.uil;
}

function popAllEnv() { while (envStack.length) popEnv(); }

// ═════════════════════════════════════════════════════════════
// InDesign 헬퍼
// ═════════════════════════════════════════════════════════════

function resetLayer(doc, name) {
    var l = doc.layers.itemByName(name);
    if (l.isValid) { try { l.remove(); } catch (e) {} }
    return doc.layers.add({ name: name });
}

function ensureLayer(doc, name) {
    var l = doc.layers.itemByName(name);
    if (!l.isValid) l = doc.layers.add({ name: name });
    l.visible = true; l.locked = false;
    return l;
}

function getPage(doc, absPageNumber) {
    if (absPageNumber < 1 || absPageNumber > doc.pages.length) return null;
    return doc.pages.item(absPageNumber - 1);
}

function noneSwatch(doc) { return doc.swatches.itemByName("None"); }

function guideSwatch(doc) {
    var s = doc.swatches.itemByName("SpineGuide");
    if (s.isValid) return s;
    return doc.colors.add({
        name: "SpineGuide", model: ColorModel.PROCESS,
        space: ColorSpace.CMYK, colorValue: [0, 100, 100, 0]
    });
}

/* 페이지의 등쪽(gutter) 노출 스트립 bounds [y1,x1,y2,x2] */
function stripBounds(page, wrapW, bleedY) {
    var b = page.bounds;                       // [y1, x1, y2, x2] — SPREAD_ORIGIN 기준
    var top = b[0] - bleedY, bot = b[2] + bleedY;
    if (page.side === PageSideOptions.LEFT_HAND) {
        return [top, b[3] - wrapW, bot, b[3]];  // 좌측(짝수)면 → 등은 오른쪽
    }
    return [top, b[1], bot, b[1] + wrapW];      // 우측(홀수)면 → 등은 왼쪽
}

/* TOP_LEFT 기준 시계방향 90° 회전 */
function rotateCW90(item) {
    var m = app.transformationMatrices.add({ counterclockwiseRotationAngle: -90 });
    item.transform(CoordinateSpaces.PASTEBOARD_COORDINATES, AnchorPoint.TOP_LEFT_ANCHOR, m);
}

// ═════════════════════════════════════════════════════════════
// 액션 ① 책등 아트워크 캔버스 문서
// ═════════════════════════════════════════════════════════════
function makeSpineCanvas(spine, pageH, bleedY) {
    pushEnv(null);
    var doc;
    try {
        doc = app.documents.add();
        popEnv();
        pushEnv(doc);

        doc.documentPreferences.facingPages = false;
        doc.documentPreferences.pagesPerDocument = 1;

        // 여백을 먼저 0으로 내려야 한다. 새 문서의 기본 여백(좌우 각 20mm)이
        // 책등 폭보다 넓으면 pageWidth 설정이 거부된다.
        // 문서 기본값 + 실제 페이지 + 마스터 스프레드 페이지를 모두 내려야 한다.
        var zero = { top: 0, bottom: 0, left: 0, right: 0, columnCount: 1 };
        try { doc.marginPreferences.properties = zero; } catch (e0) {}
        var mi, mp;
        for (mi = 0; mi < doc.masterSpreads.length; mi++) {
            for (mp = 0; mp < doc.masterSpreads.item(mi).pages.length; mp++) {
                try {
                    doc.masterSpreads.item(mi).pages.item(mp).marginPreferences.properties = zero;
                } catch (e1) {}
            }
        }
        var page = doc.pages.item(0);
        page.marginPreferences.properties = zero;

        doc.documentPreferences.documentBleedUniformSize = false;
        doc.documentPreferences.pageWidth  = spine.totalSpine;
        doc.documentPreferences.pageHeight = pageH;
        doc.documentPreferences.documentBleedTopOffset          = bleedY;
        doc.documentPreferences.documentBleedBottomOffset       = bleedY;
        doc.documentPreferences.documentBleedInsideOrLeftOffset = 0;
        doc.documentPreferences.documentBleedOutsideOrRightOffset = 0;

        var lArt   = ensureLayer(doc, LAYER_ART);
        var lLabel = ensureLayer(doc, "대수 라벨");
        var lGuide = ensureLayer(doc, "대수 가이드");

        var i, r;

        // 가이드: 대수 경계(파랑) / 접지 중심(빨강)
        doc.activeLayer = lGuide;
        for (i = 0; i < spine.rows.length; i++) {
            r = spine.rows[i];
            page.guides.add(lGuide, {
                orientation: HorizontalOrVertical.VERTICAL, location: r.x0,
                guideColor: UIColors.BLUE
            });
            page.guides.add(lGuide, {
                orientation: HorizontalOrVertical.VERTICAL, location: r.mid,
                guideColor: UIColors.RED
            });
        }
        page.guides.add(lGuide, {
            orientation: HorizontalOrVertical.VERTICAL, location: spine.totalSpine,
            guideColor: UIColors.BLUE
        });

        // 대수 라벨 — 페이지 위쪽 여백(작업대)에 세로로
        doc.activeLayer = lLabel;
        var L = 42;                                  // 라벨 길이 mm
        for (i = 0; i < spine.rows.length; i++) {
            r = spine.rows[i];
            var tf = page.textFrames.add(lLabel);
            // 회전 전: TOP_LEFT = (r.x1, -(L+3)), 폭 L, 높이 r.thick
            tf.geometricBounds = [-(L + 3), r.x1, -(L + 3) + r.thick, r.x1 + L];
            tf.contents = "S" + r.no + "  p." + r.first + " / p." + r.last;
            tf.textFramePreferences.insetSpacing = [0, 0, 0, 0];
            tf.textFramePreferences.verticalJustification = VerticalJustification.CENTER_ALIGN;
            tf.textFramePreferences.ignoreWrap = true;
            var pt = Math.max(2, Math.min(5, r.thick * 2.8346 * 0.72));
            tf.parentStory.pointSize = pt;
            tf.parentStory.leading = pt;
            tf.parentStory.justification = Justification.LEFT_ALIGN;
            rotateCW90(tf);
        }

        // 방향 표시 + 범례
        var head = page.textFrames.add(lLabel);
        head.geometricBounds = [-(L + 16), 0, -(L + 6), Math.max(spine.totalSpine, 60)];
        head.contents = "◀ 앞표지쪽 (p.1)          뒤표지쪽 (p." +
                        spine.rows[spine.rows.length - 1].last + ") ▶";
        head.parentStory.pointSize = 7;
        head.textFramePreferences.insetSpacing = [0, 0, 0, 0];

        var legend = page.textFrames.add(lLabel);
        legend.geometricBounds = [0, spine.totalSpine + 12, pageH, spine.totalSpine + 92];
        legend.contents = buildLegend(spine);
        legend.parentStory.pointSize = 7;
        legend.parentStory.leading = 9;

        lGuide.locked = true;
        lLabel.locked = true;
        doc.activeLayer = lArt;

        popEnv();
        return doc;
    } catch (e) {
        popAllEnv();
        throw e;
    }
}

function buildLegend(spine) {
    var s = "책등 캔버스  " + fx(spine.totalSpine, 2) + " mm\n";
    s += "대수 " + spine.rows.length + "대 · 가로 해상도 " + spine.rows.length + " 밴드\n";
    s += "파랑=대수 경계 / 빨강=접지 중심\n\n";
    var i, r;
    for (i = 0; i < spine.rows.length; i++) {
        r = spine.rows[i];
        s += "S" + r.no + "  p." + r.first + "/" + r.last +
             "  " + fx(r.thick, 2) + "mm  [" + fx(r.x0, 2) + "–" + fx(r.x1, 2) + "]\n";
    }
    return s;
}

// ═════════════════════════════════════════════════════════════
// 액션 ② 현재 문서 노출영역 가이드 + 안전영역 검사
// ═════════════════════════════════════════════════════════════
function markExposedAreas(doc, spine, bleedY) {
    pushEnv(doc);
    try {
        var layer = resetLayer(doc, LAYER_GUIDE);
        var sw = guideSwatch(doc), none = noneSwatch(doc);
        var made = 0, missing = [], violations = [];
        var i, k, r, targets, page, gb, rect, mp, inside;

        for (i = 0; i < spine.rows.length; i++) {
            r = spine.rows[i];
            targets = [r.first, r.last];
            for (k = 0; k < 2; k++) {
                page = getPage(doc, targets[k]);
                if (!page) { missing.push(targets[k]); continue; }

                gb = stripBounds(page, r.wrapW, bleedY);
                rect = page.rectangles.add(layer);
                rect.geometricBounds = gb;
                rect.fillColor = none;
                rect.strokeColor = sw;
                rect.strokeWeight = 0.25;
                rect.strokeAlignment = StrokeAlignment.INSIDE_ALIGNMENT;
                rect.label = "SPINEGUIDE|S" + r.no + "|p" + targets[k] + "|" + fx(r.wrapW, 3);
                made++;

                // 본문 안쪽 여백이 노출 폭보다 좁으면 경고
                mp = page.marginPreferences;
                inside = (page.side === PageSideOptions.LEFT_HAND) ? mp.right : mp.left;
                if (typeof inside === "number" && inside < r.wrapW) {
                    violations.push("p." + targets[k] + " (여백 " + fx(inside, 2) +
                                    "mm < 노출 " + fx(r.wrapW, 2) + "mm)");
                }
            }
        }
        popEnv();
        return { made: made, missing: missing, violations: violations };
    } catch (e) { popAllEnv(); throw e; }
}

// ═════════════════════════════════════════════════════════════
// 액션 ③ 책등 이미지 대수 분할 배치
//   슬라이스 [a,b] 를 프레임 좌단 정렬로 넣고 좌우 반전
//   → 접지를 돌아 나오는 물리적 방향과 일치
// ═════════════════════════════════════════════════════════════
function placeSpineArt(doc, spine, file, bleedY, curvature, includeBleed) {
    pushEnv(doc);
    try {
        var layer = resetLayer(doc, LAYER_ART);
        var none = noneSwatch(doc);
        var S = spine.totalSpine;
        var drawnW = S * curvature;            // 아트워크가 펼쳐져 인쇄되는 총 가로 길이
        var by = includeBleed ? bleedY : 0;

        try {
            app.pdfPlacePreferences.pageNumber = 1;
            app.pdfPlacePreferences.transparentBackground = true;
            app.pdfPlacePreferences.pdfCrop = includeBleed ? PDFCrop.CROP_MEDIA : PDFCrop.CROP_TRIM;
        } catch (e) {}

        var placed = 0, missing = [], failed = [];
        var i, k, r, targets, ranges, page, gb, rect, arr, gfx, a;

        for (i = 0; i < spine.rows.length; i++) {
            r = spine.rows[i];
            targets = [r.first, r.last];
            ranges  = [[r.x0, r.mid], [r.mid, r.x1]];   // 첫 쪽=앞쪽 절반, 마지막 쪽=뒤쪽 절반
            for (k = 0; k < 2; k++) {
                page = getPage(doc, targets[k]);
                if (!page) { missing.push(targets[k]); continue; }

                gb = stripBounds(page, r.wrapW, by);
                rect = page.rectangles.add(layer);
                rect.geometricBounds = gb;
                rect.fillColor = none;
                rect.strokeColor = none;

                arr = rect.place(file);
                if (!arr || arr.length === 0) { failed.push(targets[k]); rect.remove(); continue; }
                gfx = arr[0];

                a = ranges[k][0];
                var imgLeft = gb[1] - a * curvature;
                gfx.geometricBounds = [gb[0], imgLeft, gb[2], imgLeft + drawnW];

                rect.flipItem(Flip.HORIZONTAL, AnchorPoint.CENTER_ANCHOR);
                rect.label = "SPINEART|S" + r.no + "|p" + targets[k] +
                             "|s" + fx(ranges[k][0], 3) + "-" + fx(ranges[k][1], 3);
                placed++;
            }
        }
        popEnv();
        return { placed: placed, missing: missing, failed: failed };
    } catch (e) { popAllEnv(); throw e; }
}

// ═════════════════════════════════════════════════════════════
// 리포트 / JSON
// ═════════════════════════════════════════════════════════════
function buildReport(spine, m) {
    var s = "";
    s += "노출사철제본 책등 계산 리포트\n";
    s += "========================================\n";
    s += "용지           : " + m.paper + " " + m.gsm + "g\n";
    s += "낱장 두께      : " + fx(m.caliper, 4) + " mm\n";
    s += "판형           : " + fx(m.pageW, 1) + " x " + fx(m.pageH, 1) + " mm\n";
    s += "총 페이지      : " + m.totalPages + " p\n";
    s += "대수 구성      : " + m.sigDesc + "  (총 " + spine.rows.length + "대)\n";
    s += "실 보정        : " + fx(m.thread, 3) + " mm / 대수\n";
    s += "대수 간격      : " + fx(m.gap, 3) + " mm\n";
    s += "접지 곡률계수  : " + fx(m.curvature, 2) + "\n";
    s += "----------------------------------------\n";
    s += "책등 총 두께   : " + fx(spine.totalSpine, 2) + " mm\n";
    s += "등 노출 페이지 : " + (spine.rows.length * 2) + " 쪽\n";
    s += "가로 해상도    : " + spine.rows.length + " 밴드 (= 대수 개수)\n";
    s += "노출 여백      : " + fx(spine.minWrap, 2) + " ~ " + fx(spine.maxWrap, 2) + " mm\n";
    s += "권장 안쪽 여백 : " + fx(spine.maxWrap + 2, 1) + " mm 이상\n";
    s += "========================================\n\n";
    s += "대수,페이지범위,등노출쪽,대수두께mm,등면시작mm,등면끝mm,접지중심mm,노출여백mm\n";
    var i, r;
    for (i = 0; i < spine.rows.length; i++) {
        r = spine.rows[i];
        s += "S" + r.no + "," + r.first + "-" + r.last + ",p." + r.first + "+p." + r.last + ","
           + fx(r.thick, 3) + "," + fx(r.x0, 3) + "," + fx(r.x1, 3) + ","
           + fx(r.mid, 3) + "," + fx(r.wrapW, 3) + "\n";
    }
    s += "\n※ 공칭 추정치입니다. 더미북 실측 후 [실측 보정]으로 재계산하세요.\n";
    return s;
}

function buildJSON(spine, m) {
    var q = function (v) { return '"' + String(v).replace(/"/g, '\\"') + '"'; };
    var s = "{\n";
    s += '  "unit": "mm",\n';
    s += '  "paper": ' + q(m.paper) + ',\n';
    s += '  "gsm": ' + q(m.gsm) + ',\n';
    s += '  "caliper": ' + fx(m.caliper, 4) + ',\n';
    s += '  "pageWidth": ' + fx(m.pageW, 2) + ',\n';
    s += '  "pageHeight": ' + fx(m.pageH, 2) + ',\n';
    s += '  "totalPages": ' + m.totalPages + ',\n';
    s += '  "threadPerSignature": ' + fx(m.thread, 3) + ',\n';
    s += '  "signatureGap": ' + fx(m.gap, 3) + ',\n';
    s += '  "curvature": ' + fx(m.curvature, 2) + ',\n';
    s += '  "bleed": ' + fx(m.bleed, 2) + ',\n';
    s += '  "artworkIncludesBleed": ' + (m.incBleed ? "true" : "false") + ',\n';
    s += '  "spineWidth": ' + fx(spine.totalSpine, 3) + ',\n';
    s += '  "bands": ' + spine.rows.length + ',\n';
    s += '  "signatures": [\n';
    var i, r;
    for (i = 0; i < spine.rows.length; i++) {
        r = spine.rows[i];
        s += '    { "no": ' + r.no + ', "pages": ' + r.pages
           + ', "firstPage": ' + r.first + ', "lastPage": ' + r.last
           + ', "thickness": ' + fx(r.thick, 4)
           + ', "spineStart": ' + fx(r.x0, 4)
           + ', "spineMid": ' + fx(r.mid, 4)
           + ', "spineEnd": ' + fx(r.x1, 4)
           + ', "wrapWidth": ' + fx(r.wrapW, 4)
           + ', "slices": [ { "page": ' + r.first + ', "side": "recto", "gutter": "left", '
           + '"from": ' + fx(r.x0, 4) + ', "to": ' + fx(r.mid, 4) + ', "mirrored": true }, '
           + '{ "page": ' + r.last + ', "side": "verso", "gutter": "right", '
           + '"from": ' + fx(r.mid, 4) + ', "to": ' + fx(r.x1, 4) + ', "mirrored": true } ] }'
           + (i < spine.rows.length - 1 ? "," : "") + "\n";
    }
    s += "  ]\n}\n";
    return s;
}

function writeTextFile(f, str) {
    f.encoding = "UTF-8";
    f.open("w");
    f.write(str);
    f.close();
}

// ═════════════════════════════════════════════════════════════
// UI
// ═════════════════════════════════════════════════════════════
function main() {

    var state = { spine: null, inp: null, meta: null };
    var store = readStore();

    // 이전 실행으로 열려 있던 창이 있으면 닫는다 (session 엔진은 상태가 남는다)
    try { if ($.global.__SpineCalcWin && $.global.__SpineCalcWin.visible) { $.global.__SpineCalcWin.close(); } } catch (eW) {}

    var w = new Window("palette", "SpineCalc — 노출사철제본 책등 계산기");
    w.orientation = "row";
    w.alignChildren = "top";

    // ── 왼쪽 입력 ────────────────────────────
    var left = w.add("group");
    left.orientation = "column"; left.alignChildren = "fill";
    left.preferredSize.width = 330;

    var pPre = left.add("panel", undefined, "프리셋");
    pPre.orientation = "column"; pPre.alignChildren = "fill"; pPre.margins = 12;
    var z1 = pPre.add("group");
    var ddPreset = z1.add("dropdownlist"); ddPreset.preferredSize.width = 190;
    var btPreLoad = z1.add("button", undefined, "불러오기"); btPreLoad.preferredSize.width = 90;
    var z2 = pPre.add("group");
    var btPreSave = z2.add("button", undefined, "현재 값으로 저장");
    var btPreDel  = z2.add("button", undefined, "삭제"); btPreDel.preferredSize.width = 70;

    var pP = left.add("panel", undefined, "1. 용지");
    pP.orientation = "column"; pP.alignChildren = "fill"; pP.margins = 12;

    var a1 = pP.add("group"); a1.add("statictext", undefined, "종류").preferredSize.width = 72;
    var ddPaper = a1.add("dropdownlist"); ddPaper.preferredSize.width = 205;
    for (var i = 0; i < PAPERS.length; i++) ddPaper.add("item", PAPERS[i].name);
    ddPaper.selection = 1;

    var a2 = pP.add("group"); a2.add("statictext", undefined, "평량 g/m²").preferredSize.width = 72;
    var ddGsm = a2.add("dropdownlist"); ddGsm.preferredSize.width = 205;

    var a3 = pP.add("group"); a3.add("statictext", undefined, "낱장 두께").preferredSize.width = 72;
    var etCaliper = a3.add("edittext", undefined, "0.130"); etCaliper.preferredSize.width = 70;
    a3.add("statictext", undefined, "mm");
    var cbManual = a3.add("checkbox", undefined, "직접 입력");

    var pS = left.add("panel", undefined, "2. 대수 / 제본");
    pS.orientation = "column"; pS.alignChildren = "fill"; pS.margins = 12;

    var b1 = pS.add("group"); b1.add("statictext", undefined, "총 페이지").preferredSize.width = 92;
    var etTotal = b1.add("edittext", undefined, "208"); etTotal.preferredSize.width = 66;
    var btGrab = b1.add("button", undefined, "현재 문서"); btGrab.preferredSize.width = 86;

    var b2 = pS.add("group"); b2.add("statictext", undefined, "대수 페이지").preferredSize.width = 92;
    var ddSig = b2.add("dropdownlist", undefined, ["8", "16", "32", "수동 입력"]);
    ddSig.preferredSize.width = 105; ddSig.selection = 1;

    var b3 = pS.add("group"); b3.add("statictext", undefined, "수동 구성").preferredSize.width = 92;
    var etManualSig = b3.add("edittext", undefined, "16,16,16,8");
    etManualSig.preferredSize.width = 160; etManualSig.enabled = false;

    var b4 = pS.add("group"); b4.add("statictext", undefined, "실 보정 /대수").preferredSize.width = 92;
    var etThread = b4.add("edittext", undefined, "0.25"); etThread.preferredSize.width = 58;
    b4.add("statictext", undefined, "mm");

    var b5 = pS.add("group"); b5.add("statictext", undefined, "대수 간격").preferredSize.width = 92;
    var etGap = b5.add("edittext", undefined, "0"); etGap.preferredSize.width = 58;
    b5.add("statictext", undefined, "mm");

    var b6 = pS.add("group"); b6.add("statictext", undefined, "접지 곡률계수").preferredSize.width = 92;
    var etCurv = b6.add("edittext", undefined, "1.57"); etCurv.preferredSize.width = 58;
    b6.add("statictext", undefined, "1.0 각접지 / 1.57 반원");

    var pF = left.add("panel", undefined, "3. 판형 / 재단");
    pF.orientation = "column"; pF.alignChildren = "fill"; pF.margins = 12;
    var c1 = pF.add("group"); c1.add("statictext", undefined, "판형 W x H").preferredSize.width = 92;
    var etPageW = c1.add("edittext", undefined, "148"); etPageW.preferredSize.width = 50;
    c1.add("statictext", undefined, "x");
    var etPageH = c1.add("edittext", undefined, "210"); etPageH.preferredSize.width = 50;
    c1.add("statictext", undefined, "mm");
    var c2 = pF.add("group"); c2.add("statictext", undefined, "재단물림 상하").preferredSize.width = 92;
    var etBleed = c2.add("edittext", undefined, "3"); etBleed.preferredSize.width = 50;
    c2.add("statictext", undefined, "mm");
    var cbBleed = pF.add("checkbox", undefined, "아트워크에 상하 도련이 포함되어 있음");
    cbBleed.value = true;

    var pC = left.add("panel", undefined, "4. 실측 보정  ← 인쇄 전 필수");
    pC.orientation = "column"; pC.alignChildren = "fill"; pC.margins = 12;
    var d1 = pC.add("group"); d1.add("statictext", undefined, "더미북 실측 등두께").preferredSize.width = 118;
    var etMeasured = d1.add("edittext", undefined, ""); etMeasured.preferredSize.width = 58;
    d1.add("statictext", undefined, "mm");
    var btCal = pC.add("button", undefined, "실측값으로 계수 역산");

    // ── 오른쪽 결과 ──────────────────────────
    var right = w.add("group");
    right.orientation = "column"; right.alignChildren = "fill";
    right.preferredSize.width = 450;

    var pR = right.add("panel", undefined, "계산 결과");
    pR.orientation = "column"; pR.alignChildren = "fill"; pR.margins = 12;

    var stSummary = pR.add("statictext", undefined, "", { multiline: true });
    stSummary.preferredSize.height = 72;

    var lb = pR.add("listbox", undefined, [], {
        numberOfColumns: 6, showHeaders: true,
        columnTitles: ["대수", "페이지", "등 노출", "두께mm", "등면 위치", "노출여백"],
        columnWidths: [42, 78, 96, 62, 92, 66]
    });
    lb.preferredSize.height = 250;

    var btCalc = pR.add("button", undefined, "계산하기");

    var pAct = right.add("panel", undefined, "실행");
    pAct.orientation = "column"; pAct.alignChildren = "fill"; pAct.margins = 12;
    var btCanvas = pAct.add("button", undefined, "① 책등 아트워크 캔버스 문서 만들기");
    var btMark   = pAct.add("button", undefined, "② 현재 문서에 노출영역 가이드 표시");
    var btArt    = pAct.add("button", undefined, "③ 책등 이미지 대수 분할 배치");
    var gExp = pAct.add("group"); gExp.alignChildren = "fill";
    var btSave = gExp.add("button", undefined, "④ 리포트 저장 (.csv)");
    var btJson = gExp.add("button", undefined, "⑤ 좌표 JSON 내보내기");

    var btm = right.add("group"); btm.alignment = "right";
    var btClose = btm.add("button", undefined, "닫기");
    btClose.onClick = function () { saveLast(); w.close(); };

    // ── 용지 연동 ────────────────────────────
    function fillGsm() {
        var p = PAPERS[ddPaper.selection.index];
        ddGsm.removeAll();
        for (var j = 0; j < p.gsm.length; j++) ddGsm.add("item", String(p.gsm[j]));
        ddGsm.selection = (p.gsm.length > 2 ? 2 : 0);
        if (p.bulk === 0) cbManual.value = true; else cbManual.value = false;
        syncCaliper();
    }
    function syncCaliper() {
        var p = PAPERS[ddPaper.selection.index];
        if (p.bulk === 0) cbManual.value = true;
        ddGsm.enabled = (p.bulk !== 0);
        etCaliper.enabled = cbManual.value;
        if (cbManual.value || p.bulk === 0) return;
        if (!ddGsm.selection) return;
        etCaliper.text = fx(paperThickness(ddPaper.selection.index, parseFloat(ddGsm.selection.text)), 4);
    }
    ddPaper.onChange = fillGsm;
    ddGsm.onChange = syncCaliper;
    cbManual.onClick = syncCaliper;
    ddSig.onChange = function () { etManualSig.enabled = (ddSig.selection.index === 3); };

    // ── 값 저장 / 복원 ───────────────────────
    function collect() {
        return {
            paper:     PAPERS[ddPaper.selection.index].name,
            gsm:       (ddGsm.selection ? ddGsm.selection.text : ""),
            manual:    cbManual.value ? "1" : "0",
            caliper:   etCaliper.text,
            total:     etTotal.text,
            sig:       ddSig.selection.text,
            manualSig: etManualSig.text,
            thread:    etThread.text,
            gap:       etGap.text,
            curv:      etCurv.text,
            pageW:     etPageW.text,
            pageH:     etPageH.text,
            bleed:     etBleed.text,
            incBleed:  cbBleed.value ? "1" : "0",
            measured:  etMeasured.text
        };
    }

    /* 순서가 중요하다. 용지/평량을 바꾸면 onChange가 두께를 다시 계산하므로
       직접 입력한 두께는 반드시 마지막에 되돌려 놓아야 한다. */
    function apply(v) {
        if (!v) return;
        var i;
        if (v.paper) {
            for (i = 0; i < PAPERS.length; i++) {
                if (PAPERS[i].name === v.paper) { ddPaper.selection = i; fillGsm(); break; }
            }
        }
        if (v.gsm) {
            for (i = 0; i < ddGsm.items.length; i++) {
                if (ddGsm.items[i].text === v.gsm) { ddGsm.selection = i; break; }
            }
        }
        if (v.manual !== undefined) { cbManual.value = (v.manual === "1"); }
        syncCaliper();
        if (v.manual === "1" && v.caliper) { etCaliper.text = v.caliper; }

        if (v.total !== undefined)     etTotal.text = v.total;
        if (v.sig) {
            for (i = 0; i < ddSig.items.length; i++) {
                if (ddSig.items[i].text === v.sig) { ddSig.selection = i; break; }
            }
            etManualSig.enabled = (ddSig.selection.index === 3);
        }
        if (v.manualSig !== undefined) etManualSig.text = v.manualSig;
        if (v.thread !== undefined)    etThread.text = v.thread;
        if (v.gap !== undefined)       etGap.text = v.gap;
        if (v.curv !== undefined)      etCurv.text = v.curv;
        if (v.pageW !== undefined)     etPageW.text = v.pageW;
        if (v.pageH !== undefined)     etPageH.text = v.pageH;
        if (v.bleed !== undefined)     etBleed.text = v.bleed;
        if (v.incBleed !== undefined)  cbBleed.value = (v.incBleed === "1");
        if (v.measured !== undefined)  etMeasured.text = v.measured;
    }

    function saveLast() {
        try { store.last = collect(); writeStore(store); } catch (e) {}
    }

    function refreshPresets(selectName) {
        ddPreset.removeAll();
        var i;
        for (i = 0; i < store.order.length; i++) { ddPreset.add("item", store.order[i]); }
        if (ddPreset.items.length === 0) {
            ddPreset.add("item", "(저장된 프리셋 없음)");
            ddPreset.selection = 0; ddPreset.enabled = false;
            btPreLoad.enabled = false; btPreDel.enabled = false;
            return;
        }
        ddPreset.enabled = true; btPreLoad.enabled = true; btPreDel.enabled = true;
        if (selectName) {
            for (i = 0; i < ddPreset.items.length; i++) {
                if (ddPreset.items[i].text === selectName) { ddPreset.selection = i; return; }
            }
        }
        ddPreset.selection = 0;
    }

    btPreLoad.onClick = function () {
        if (!ddPreset.selection || !ddPreset.enabled) return;
        var nm = ddPreset.selection.text;
        if (!store.presets[nm]) { alert("프리셋을 찾을 수 없습니다: " + nm); return; }
        apply(store.presets[nm]);
        calc();
    };

    btPreSave.onClick = function () {
        var suggested = (ddPreset.enabled && ddPreset.selection) ? ddPreset.selection.text : "";
        var nm = prompt("프리셋 이름", suggested, "프리셋 저장");
        if (nm === null) return;
        nm = cleanPresetName(nm);
        if (!nm) { alert("이름을 입력하세요."); return; }
        var exists = !!store.presets[nm];
        if (exists && !confirm("'" + nm + "' 프리셋을 덮어쓸까요?")) return;
        store.presets[nm] = collect();
        if (!exists) store.order.push(nm);
        if (!writeStore(store)) { alert("설정 파일을 저장하지 못했습니다."); return; }
        refreshPresets(nm);
        alert("프리셋 '" + nm + "' 저장했습니다.");
    };

    btPreDel.onClick = function () {
        if (!ddPreset.selection || !ddPreset.enabled) return;
        var nm = ddPreset.selection.text;
        if (!confirm("프리셋 '" + nm + "' 을(를) 삭제할까요?")) return;
        delete store.presets[nm];
        var i, ord = [];
        for (i = 0; i < store.order.length; i++) {
            if (store.order[i] !== nm) ord.push(store.order[i]);
        }
        store.order = ord;
        writeStore(store);
        refreshPresets();
    };

    // ── 입력 읽기 ────────────────────────────
    function readInputs() {
        var caliper = parseFloat(etCaliper.text);
        var total   = parseInt(etTotal.text, 10);
        var thread  = parseFloat(etThread.text);
        var gap     = parseFloat(etGap.text);
        var curv    = parseFloat(etCurv.text);
        var pageW   = parseFloat(etPageW.text);
        var pageH   = parseFloat(etPageH.text);
        var bleed   = parseFloat(etBleed.text);

        if (isNaN(caliper) || caliper <= 0) { alert("낱장 두께를 확인하세요."); return null; }
        if (isNaN(total) || total <= 0)     { alert("총 페이지 수를 확인하세요."); return null; }
        if (total % 4 !== 0) { alert("총 페이지 수는 4의 배수여야 합니다.\n현재: " + total + "p"); return null; }
        if (isNaN(thread) || thread < 0) thread = 0;
        if (isNaN(gap) || gap < 0) gap = 0;
        if (isNaN(curv) || curv <= 0) curv = 1.57;
        if (isNaN(pageW) || pageW <= 0) pageW = 148;
        if (isNaN(pageH) || pageH <= 0) pageH = 210;
        if (isNaN(bleed) || bleed < 0) bleed = 0;

        var sigs, desc;
        if (ddSig.selection.index === 3) {
            sigs = parseManualSignatures(etManualSig.text);
            if (!sigs) { alert("수동 구성은 4의 배수를 쉼표로 구분해 입력하세요.\n예) 16,16,8"); return null; }
            var sum = 0;
            for (var j = 0; j < sigs.length; j++) sum += sigs[j];
            if (sum !== total) {
                alert("수동 구성 합(" + sum + "p)이 총 페이지(" + total + "p)와 다릅니다."); return null;
            }
            desc = etManualSig.text;
        } else {
            var sz = parseInt(ddSig.selection.text, 10);
            sigs = composeSignatures(total, sz);
            if (!sigs) { alert("대수 구성을 만들 수 없습니다."); return null; }
            desc = sz + "p 기준";
        }
        return {
            caliper: caliper, total: total, thread: thread, gap: gap, curvature: curv,
            sigs: sigs, desc: desc, pageW: pageW, pageH: pageH, bleed: bleed,
            includeBleed: cbBleed.value
        };
    }

    function calc() {
        var inp = readInputs();
        if (!inp) return false;
        var spine = buildSpine(inp.sigs, inp.caliper, inp.thread, inp.gap, inp.curvature);
        state.spine = spine;
        state.inp = inp;
        state.meta = {
            paper: (cbManual.value ? "직접 입력" : PAPERS[ddPaper.selection.index].name),
            gsm: (ddGsm.enabled && ddGsm.selection ? ddGsm.selection.text : "-"),
            caliper: inp.caliper, totalPages: inp.total, sigDesc: inp.desc,
            thread: inp.thread, gap: inp.gap, curvature: inp.curvature,
            pageW: inp.pageW, pageH: inp.pageH,
            bleed: inp.bleed, incBleed: inp.includeBleed
        };

        var wrapTxt = (fx(spine.minWrap, 2) === fx(spine.maxWrap, 2))
            ? fx(spine.maxWrap, 2) + " mm"
            : fx(spine.minWrap, 2) + " ~ " + fx(spine.maxWrap, 2) + " mm";

        stSummary.text =
            "책등 총 두께   " + fx(spine.totalSpine, 2) + " mm\n" +
            "대수 " + spine.rows.length + "대 · 등 노출 " + (spine.rows.length * 2) + "쪽 · " +
            "가로 해상도 " + spine.rows.length + " 밴드\n" +
            "페이지 노출 여백   " + wrapTxt + "\n" +
            "→ 본문 안쪽 여백 " + fx(spine.maxWrap + 2, 1) + " mm 이상 확보 권장";

        lb.removeAll();
        for (var j = 0; j < spine.rows.length; j++) {
            var r = spine.rows[j];
            var it = lb.add("item", "S" + r.no);
            it.subItems[0].text = r.first + "-" + r.last;
            it.subItems[1].text = "p." + r.first + " + p." + r.last;
            it.subItems[2].text = fx(r.thick, 3);
            it.subItems[3].text = fx(r.x0, 2) + "-" + fx(r.x1, 2);
            it.subItems[4].text = fx(r.wrapW, 3);
        }
        saveLast();            // 계산할 때마다 마지막 값 갱신
        return true;
    }

    function ready() { return state.spine ? true : calc(); }

    function checkDoc() {
        if (app.documents.length === 0) { alert("먼저 본문 문서를 여세요."); return null; }
        var d = app.activeDocument;
        if (!d.documentPreferences.facingPages) {
            alert("이 문서는 '페이지 마주보기'가 꺼져 있습니다.\n" +
                  "노출사철 계산은 마주보기 문서를 전제로 합니다.\n" +
                  "문서 설정에서 켠 뒤 다시 실행하세요.");
            return null;
        }
        if (d.pages.length !== state.inp.total) {
            alert("문서 페이지 수(" + d.pages.length + "p)와 입력값(" +
                  state.inp.total + "p)이 다릅니다.\n먼저 맞춰 주세요.");
            return null;
        }
        return d;
    }

    // ── 버튼 ─────────────────────────────────
    btCalc.onClick = calc;

    btGrab.onClick = function () {
        if (app.documents.length === 0) { alert("열려 있는 문서가 없습니다."); return; }
        etTotal.text = String(app.activeDocument.pages.length);
        try {
            app.scriptPreferences.measurementUnit = MeasurementUnits.MILLIMETERS;
            etPageW.text = fx(app.activeDocument.documentPreferences.pageWidth, 1);
            etPageH.text = fx(app.activeDocument.documentPreferences.pageHeight, 1);
        } catch (e) {}
        calc();
    };

    btCal.onClick = function () {
        var m = parseFloat(etMeasured.text);
        if (isNaN(m) || m <= 0) { alert("실측 등두께(mm)를 입력하세요."); return; }
        var inp = readInputs();
        if (!inp) return;
        var leavesTotal = 0;
        for (var j = 0; j < inp.sigs.length; j++) leavesTotal += inp.sigs[j] / 2;
        var nSig = inp.sigs.length;
        var gapTotal = inp.gap * (nSig - 1);
        var newThread = (m - gapTotal - leavesTotal * inp.caliper) / nSig;
        if (newThread < 0) {
            alert("실측값이 계산 하한보다 작습니다.\n용지 두께가 과대 추정된 것 같습니다.\n\n" +
                  "제안: 낱장 두께를 " + fx((m - gapTotal) / leavesTotal, 4) +
                  " mm 로 직접 입력하고 실 보정을 0으로 두세요.");
            return;
        }
        etThread.text = fx(newThread, 3);
        calc();
        alert("실 보정계수를 " + fx(newThread, 3) + " mm/대수 로 역산하고 재계산했습니다.");
    };

    btCanvas.onClick = function () {
        if (!ready()) return;
        saveLast();
        try {
            makeSpineCanvas(state.spine, state.inp.pageH, state.inp.bleed);
            alert("책등 캔버스 문서를 만들었습니다.\n\n" +
                  "크기  " + fx(state.spine.totalSpine, 2) + " x " + fx(state.inp.pageH, 1) + " mm" +
                  " (상하 도련 " + fx(state.inp.bleed, 1) + "mm)\n" +
                  "파랑 가이드 = 대수 경계\n" +
                  "빨강 가이드 = 접지 중심 (앞/뒤 페이지 분기)\n\n" +
                  "'" + LAYER_ART + "' 레이어에 그림을 그린 뒤\n" +
                  "도련 포함 PDF로 내보내고 ③번으로 배치하세요.");
        } catch (e) { alert("실패: " + e + "\n(줄 " + e.line + ")"); }
    };

    btMark.onClick = function () {
        if (!ready()) return;
        saveLast();
        var d = checkDoc(); if (!d) return;
        try {
            var res = markExposedAreas(d, state.spine, state.inp.bleed);
            var msg = "'" + LAYER_GUIDE + "' 레이어에 노출영역 " + res.made + "개를 표시했습니다.";
            if (res.missing.length) msg += "\n\n문서에 없는 페이지: " + res.missing.join(", ");
            if (res.violations.length) {
                msg += "\n\n⚠ 본문 안쪽 여백이 노출 폭보다 좁습니다 (" +
                       res.violations.length + "곳)\n" + res.violations.slice(0, 8).join("\n");
                if (res.violations.length > 8) msg += "\n… 외 " + (res.violations.length - 8) + "곳";
            }
            alert(msg);
        } catch (e) { alert("실패: " + e + "\n(줄 " + e.line + ")"); }
    };

    btArt.onClick = function () {
        if (!ready()) return;
        saveLast();
        var d = checkDoc(); if (!d) return;
        var f = File.openDialog("책등 아트워크 파일 선택 (PDF / AI / PSD / TIF / PNG / JPG)");
        if (!f) return;
        try {
            var res = placeSpineArt(d, state.spine, f, state.inp.bleed,
                                    state.inp.curvature, state.inp.includeBleed);
            var msg = "'" + LAYER_ART + "' 레이어에 슬라이스 " + res.placed + "개를 배치했습니다.";
            if (res.missing.length) msg += "\n\n문서에 없는 페이지: " + res.missing.join(", ");
            if (res.failed.length)  msg += "\n\n배치 실패 페이지: " + res.failed.join(", ");
            alert(msg);
        } catch (e) { alert("실패: " + e + "\n(줄 " + e.line + ")"); }
    };

    btSave.onClick = function () {
        if (!ready()) return;
        var f = File.saveDialog("리포트 저장");
        if (!f) return;
        if (!/\.(csv|txt)$/i.test(f.fsName)) f = new File(f.fsName + ".csv");
        writeTextFile(f, buildReport(state.spine, state.meta));
        alert("저장했습니다:\n" + f.fsName);
    };

    btJson.onClick = function () {
        if (!ready()) return;
        var f = File.saveDialog("좌표 JSON 내보내기");
        if (!f) return;
        if (!/\.json$/i.test(f.fsName)) f = new File(f.fsName + ".json");
        writeTextFile(f, buildJSON(state.spine, state.meta));
        alert("저장했습니다:\n" + f.fsName);
    };

    fillGsm();
    refreshPresets();
    apply(store.last);         // 지난번에 쓰던 값 복원
    calc();

    w.onClose = function () { saveLast(); return true; };

    $.global.__SpineCalcWin = w;   // 참조를 남겨야 palette가 살아 있는다
    $.global.__SpineCalcUI = {     // 자동화/검증용 버튼 핸들
        calc: btCalc, canvas: btCanvas, mark: btMark,
        art: btArt, csv: btSave, json: btJson,
        presetList: ddPreset, presetLoad: btPreLoad, presetSave: btPreSave, presetDel: btPreDel,
        collect: null, apply: null,
        state: state, readInputs: readInputs
    };
    $.global.__SpineCalcUI.collect = collect;
    $.global.__SpineCalcUI.apply = apply;
    $.global.__SpineCalcUI.store = function () { return store; };
    w.show();
}

// ═════════════════════════════════════════════════════════════
// 외부 호출용 API — 다른 스크립트/자동화에서 UI 없이 쓸 수 있게 노출
//   $.global.SPINECALC_NO_UI = true; 로 두고 이 파일을 eval 하면
//   대화상자를 띄우지 않고 $.global.SpineCalc 만 준비된다.
// ═════════════════════════════════════════════════════════════
$.global.SpineCalc = {
    version: 2,
    PAPERS: PAPERS,
    LAYER_GUIDE: LAYER_GUIDE,
    LAYER_ART: LAYER_ART,
    paperThickness: paperThickness,
    composeSignatures: composeSignatures,
    parseManualSignatures: parseManualSignatures,
    buildSpine: buildSpine,
    makeSpineCanvas: makeSpineCanvas,
    markExposedAreas: markExposedAreas,
    placeSpineArt: placeSpineArt,
    buildReport: buildReport,
    buildJSON: buildJSON,
    stripBounds: stripBounds,
    popAllEnv: popAllEnv
};

if (!$.global.SPINECALC_NO_UI) {
    try { main(); }
    catch (e) { popAllEnv(); alert("SpineCalc 오류: " + e + "\n(줄 " + e.line + ")"); }
    finally { popAllEnv(); }
}

})();
