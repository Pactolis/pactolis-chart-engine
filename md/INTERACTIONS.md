# INTERACTIONS.md — Pointer/touch/keyboard etkileşim matrisi (kanonik)

Bu belge engine'in kanonik pointer/touch/keyboard/axis/drawing davranış matrisidir. Source:
[src/features/chart/axisInteraction.ts](../src/features/chart/axisInteraction.ts) (bölge hit-test),
[src/features/chart/ChartInputController.ts](../src/features/chart/ChartInputController.ts) (olay
bağlama), [src/features/chart/touchGestures.ts](../src/features/chart/touchGestures.ts) (dokunma
sabitleri ve saf yardımcılar), [src/features/chart/interactionPolicy.ts](../src/features/chart/interactionPolicy.ts)
(anahtarlar), [src/features/chart/contextMenuModel.ts](../src/features/chart/contextMenuModel.ts)
(sağ-tık menü), [src/features/chart/wheelPolicy.ts](../src/features/chart/wheelPolicy.ts).

Testler: `tests/chartAxisInteraction.test.mjs`, `tests/chartInteractionPolicy.test.mjs`,
`tests/chartWheelPolicy.test.mjs`, `tests/chartDrawingMagnet.test.mjs`, `tests/touchGestures.test.mjs`,
`tests/touchControls.test.mjs`, `tests/drawingTouchTargets.test.mjs`, `tests/hudLayout.test.mjs`,
`tests/compactChartRender.test.mjs`,
`tests/browser/chart-pointer-ownership.spec.ts`, `tests/browser/chart-keyboard-ownership.spec.ts`,
`tests/browser/chart-touch-input.spec.ts` (sentetik pointer event'leri, kayıt tutan host),
`tests/browser/chart-touch-e2e.spec.ts` (Chromium dokunma emülasyonu, gerçek `touch-action`).

## Bölgeler

`hitTestChartAxis` pointer konumunu dört hedefe ayırır: `plot`, `price-axis`, `time-axis`, `corner-axis`.

## Mouse matrisi (varsayılan policy)

| Bölge | Etkileşim | Davranış |
|---|---|---|
| Plot | Mouse move | Crosshair/HUD güncellenir |
| Plot | Sol-drag | X/time pan; auto-scale kapalıysa manuel Y pan korunur |
| Plot | Wheel | X/time zoom; aktif drag sırasında da çalışır, drag snapshot yeniden bazlanır |
| Plot | Horizontal wheel | X/time pan |
| Plot | Alt + wheel | Manuel Y/price zoom; auto-scale kapanır |
| Plot | Double click | Y reset + visible data auto-fit; X viewport korunur (çizim seçimi varsa seçim davranışı) |
| Plot | Sağ tık | Context menu (`chartcontextmenu` event) |
| Price axis | Sol-drag | Y scale genişletme/daraltma (`dragScaleFactor`) |
| Price axis | Wheel / Alt + wheel | Y/price zoom |
| Price axis | Double click | Y reset + auto-fit |
| Price axis | Sol tık — fiyat eksenindeki `O` / `L` canvas düğmeleri | Fiyat ekseni üzerinde çizilen `O` (auto-scale) ve `L` (linear/log) düğmelerine klavye/Control modifier olmadan, drag olmayan sol tıklama: auto-scale toggle / linear-log toggle (host action'ları; [axisControlsRenderer.ts](../src/core/render/axisControlsRenderer.ts) :40-46 düğme rect'leri ve `O`/`L` etiketleri, [overlay.ts](../src/core/render/overlay.ts) :128-133 hit-test, [ChartInputController.ts](../src/features/chart/ChartInputController.ts) :715-739 `onPointerUp` handler'ları) |
| Time axis | Sol-drag | X scale (sıkıştırma/genişletme) |
| Time axis | Wheel / horizontal wheel | X zoom / X pan |
| Time axis | Double click | X reset + latest placement |
| Corner axis | Double click | X + Y reset |
| Tümü | `?` | `charthelp` event (yardım paneli) |

`ChartInteractionPolicy` bu davranış gruplarını scroll/scale/contextMenu/helpOverlay anahtarlarıyla
görünür kılar; `DEFAULT_CHART_INTERACTION_POLICY` tek varsayımdır.

## Touch matrisi

Dokunma yalnız `pointerType === "touch"` olan pointer'larda devreye girer. Mouse, pen ve
`pointerType`'ı boş sentetik event'ler yukarıdaki mouse matrisinin aynısıyla çalışır (3 px tıklama
payı dahil). Sabitler `touchGestures.ts`'tedir.

Interaction canvas `touch-action: none`, `user-select: none`, `-webkit-touch-callout: none` ve şeffaf
tap highlight ile oluşturulur ([ChartRuntime.ts](../src/features/chart/ChartRuntime.ts)): tarayıcı bu
canvas üzerinde sayfa kaydırma, sayfa yakınlaştırma ve geri-ileri hareketlerini başlatmaz,
dokunuşların hepsi engine'e gelir ve `pointercancel` ile kesilmez. Host bu canvas'ı saran
elemanlara kendi `touch-action` kuralını koymak zorunda değildir.

**Dokunma modu.** `Crosshair.touch` bayrağı dokunma arayüzünü açar: `O`/`L` ve `⋯` düğmeleri hover
beklemeden çizilir. Bayrak, birincil pointer dokunmatikse (`(pointer: coarse)`) ilk dokunuştan önce de
açıktır; bir dokunma pointer'ı açar, mouse veya pen hareketi kapatır (mouse takılı tablet / hibrit
cihaz).

| Bölge | Etkileşim | Davranış |
|---|---|---|
| Plot | Kısa dokunma | `TOUCH_CLICK_SLOP_PX` (10 px) içinde kalan basıp bırakma tıklamadır: düğmeleri ve çizim hedeflerini tetikler, grafiği oynatmaz |
| Plot | Tek parmak sürükleme | X/time pan; auto-scale kapalıysa manuel Y pan korunur. Parmak düştüğü yerden 10 px açılana kadar hiçbir şey kımıldamaz (ölü bölge); pan düşülen noktadan sayılır, yani eşik aşılınca grafik parmağın altına oturur ve geride kalmaz |
| Plot | `LONG_PRESS_MS` (400 ms) kıpırdamadan basılı tutma | İnceleme modu: crosshair ve HUD parmağı izler (plot ve altındaki panellerle sınırlı), grafik kaymaz. Parmak kalkınca (veya `pointercancel`) crosshair kapanır. Tarayıcının uzun basma context menu'sü bastırılır ve `chartcontextmenu` dispatch edilmez |
| Plot | İki parmak (pinch) | Yalnız zaman ekseni: parmak aralığı oranında X zoom (parmakların orta noktası yerinde kalır), orta noktanın hareketi pan'dır; auto-scale kapalıysa dikey hareket manuel Y pan'dır. Parmaklar `PINCH_MIN_DISTANCE_PX` (24 px) altındaysa o adım atlanır. Pinch crosshair'i kapatır. Bir parmak kalkınca kalan parmak plot pan'ına devam eder; üçüncü ve sonraki parmaklar yok sayılır |
| Plot, sağ üst köşe | `⋯` düğmesine dokunma | Sağ tık menüsünün aynısı: `chartcontextmenu` (`target: "plot"`), menü düğmenin altına demirlenir (`clientX/clientY`). Konumdan çizim aranmaz; seçili çizim varsa `drawingHit` true olur. Düğme (36×36 px, üstten 4 px yani bar özetinin ilk satırıyla aynı hizada, sağdan 8 px, 4 px hit payı) yalnız dokunma modunda ve crosshair kapalıyken çizilir; küçük plotta (160×120 altı) yoktur. Bar özeti bu köşe sütununu (`TOUCH_MENU_BUTTON_RESERVE`, 50 px) boş bırakır ve gerekirse satırlara sarılır |
| Plot | Çizim aracı aktif veya taslak var | Dokunma noktayı parmağın kalktığı yere koyar; sürükleme grafiği kaydırır, ikinci parmak pinch yapar (mouse'taki bas-sürükle-bırak yerleştirme dokunmada yok). Fırça (`brush`) istisnadır: basar basmaz çizer |
| Plot | Araç yok, çizime dokunma | Seçili olmayan çizim parmak kalkınca seçilir; seçili çizim basar basmaz düzenlenir/sürüklenir (mouse gibi); boş yere basmak seçimi kaldırır ve parmak grafiği kaydırır |
| Çizimler | Hit toleransı | Gövde 7 → 16 px, seviye çizgisi 9 → 18 px, tutamaç yarıçapı 4 → 8 px ([drawingHitTest.ts](../src/features/drawings/drawingHitTest.ts)) |
| Price axis | Sürükleme | Y scale (mouse ile aynı) |
| Price axis | `O` / `L` düğmelerine dokunma | Mouse'taki gibi auto-scale / linear-log toggle. Dokunma modunda eksen boyunca hep görünür, 32×32 px, ana panelin alt ucunda üst üste (üstte `O`, altta `L`), hit alanları aradaki boşluğun yarısı (3 px) kadar büyütülmüş; ana panel 130 px'ten kısaysa çizilmez. İki düğmenin kapladığı aralıktaki fiyat etiketleri çizilmez |
| Time axis | Sürükleme | X scale; ince eksen şeridine üstten `TIME_AXIS_TOUCH_SLOP_PX` (8 px) hit payı verilir |

Dokunmadan sonra `TOUCH_CONTEXT_MENU_WINDOW_MS` (2,5 sn) içinde gelen native `contextmenu` (uzun
basma) `preventDefault` edilir ama menü açmaz; klavye yolu (`ContextMenu` / Shift+`F10`) bundan
etkilenmez.

Bir parmak aynı anda tek hareketin parçasıdır (pan, pinch, inceleme, çizim sürükleme, `⋯` basışı,
gösterge ölçeği); sürerken gelen fazladan parmaklar yok sayılır, yalnız plot pan'ı ikinci parmakla
pinch'e döner.

Dar plotta bar özeti satırlara sarılır, sığmayanlar sırayla bırakılır (bkz. [INTEGRATION.md](INTEGRATION.md) "Ekrana uyarlama").

Henüz kapsanmayanlar: gösterge (indicator) panellerindeki `O`/`L` düğmeleri hâlâ hover'a bağlıdır;
çift dokunma davranışları, çizim mıknatısının dokunma eşiği ve hassas yerleştirme (büyüteç) yoktur.

## Keyboard matrisi

| Tuş | Kapsam | Davranış |
|---|---|---|
| `?` / Shift+`/` | Canvas focus | `charthelp` event |
| `Delete` / `Backspace` | Çizim | Seçili drawing silinir |
| `Ctrl/Cmd+A` | Çizim | Görünür drawing'leri seç |
| `Ctrl/Cmd+D` | Çizim | Seçiliyi duplicate |
| `Ctrl/Cmd+C` / `Ctrl/Cmd+V` | Çizim | Kopyala/yapıştır |
| `Ctrl/Cmd+Z` / `Ctrl/Cmd+Y` (veya Shift+`Z`) | Çizim | Undo / redo |
| `Escape` | Çizim/panel | İki ayrı dal: aktif drawing aracı varsa `setTool(null)` ile bırakılır ve `preventDefault` yapılır; ayrıca event henüz `defaultPrevented` değilse ve panel maximize ise maximize'dan çıkılır; aktif tool dalı `preventDefault` yaptığı için bu aynı Escape event'inde maximizeexit dalı atlanır, tool aktif değilse maximizeexit yalnızca `defaultPrevented` false ve panel maximize iken çalışır |
| `ContextMenu` / Shift+`F10` | Canvas focus | Canvas üzerinde klavye context menu: merkezde `chartcontextmenu` event'i dispatch edilir |
| `X` | Time scale | Zaman ölçeğini resetle |

Window-level shortcut'ların sahipliği `ownsWindowShortcut` sırasıyla belirlenir
([ChartInputController.ts](../src/features/chart/ChartInputController.ts) :893-899): (1) event target,
bu chart'ın `canvas.parentElement` içinde bir Node ise o chart `true` döndürür; (2) target başka bir
`.chart-interaction-canvas` içindeyse `false`; (3) diğer durumlarda owner, host'un
`getKeyboardTargetChartId?.()` sonucudur — bu callback sağlanmamış olsa da callback `undefined`
döndürse de `owner === undefined` tüm chart'lar için ownership verir (tek chart garantisi yalnız
callback belirli/geçerli bir panel kimliği döndürdüğünde söz konusudur; `undefined` fallback'i tüm
chart'ları çalıştırır). Input/textarea/select odaklıyken veya `contentEditable` hedefte shortcut'lar
çalışmaz.

## Uygulama sahipliği

`chartcontextmenu` ve `charthelp` event'leri host uygulamanın overlay katmanına aittir; engine yalnız
event'i dispatch eder. Host örnekleri için genel akış [INTEGRATION.md](INTEGRATION.md)'de anlatılır.

Dokunmada `chartcontextmenu` `⋯` düğmesinden gelir ve `clientX/clientY` düğmenin altını gösterir,
yani plotun sağ kenarına yakındır: host menüsü kendi genişliğini görünür alana göre kırpmalıdır
(telefon genişliğinde sabit genişlikli bir menü sağ kenardan taşar).
