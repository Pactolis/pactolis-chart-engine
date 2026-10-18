# INTERACTIONS.md — Pointer/keyboard etkileşim matrisi (kanonik)

Bu belge engine'in kanonik pointer/keyboard/axis/drawing davranış matrisidir. Source:
[src/features/chart/axisInteraction.ts](../src/features/chart/axisInteraction.ts) (bölge hit-test),
[src/features/chart/ChartInputController.ts](../src/features/chart/ChartInputController.ts) (olay
bağlama), [src/features/chart/interactionPolicy.ts](../src/features/chart/interactionPolicy.ts)
(anahtarlar), [src/features/chart/contextMenuModel.ts](../src/features/chart/contextMenuModel.ts)
(sağ-tık menü), [src/features/chart/wheelPolicy.ts](../src/features/chart/wheelPolicy.ts).

Testler: `tests/chartAxisInteraction.test.mjs`, `tests/chartInteractionPolicy.test.mjs`,
`tests/chartWheelPolicy.test.mjs`, `tests/chartDrawingMagnet.test.mjs`,
`tests/browser/chart-pointer-ownership.spec.ts`, `tests/browser/chart-keyboard-ownership.spec.ts`.

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
| Price axis | Sol tık — fiyat eksenindeki `O` / `L` canvas düğmeleri | Fiyat ekseni üzerinde çizilen `O` (auto-scale) ve `L` (linear/log) düğmelerine klavye/Control modifier olmadan, drag olmayan sol tıklama: auto-scale toggle / linear-log toggle (host action'ları; [axisControlsRenderer.ts](../src/core/render/axisControlsRenderer.ts) :32-38 düğme rect'leri ve `O`/`L` etiketleri, [overlay.ts](../src/core/render/overlay.ts) :124-129 hit-test, [ChartInputController.ts](../src/features/chart/ChartInputController.ts) :431-451 `onPointerUp` handler'ları) |
| Time axis | Sol-drag | X scale (sıkıştırma/genişletme) |
| Time axis | Wheel / horizontal wheel | X zoom / X pan |
| Time axis | Double click | X reset + latest placement |
| Corner axis | Double click | X + Y reset |
| Tümü | `?` | `charthelp` event (yardım paneli) |

`ChartInteractionPolicy` bu davranış gruplarını scroll/scale/contextMenu/helpOverlay anahtarlarıyla
görünür kılar; `DEFAULT_CHART_INTERACTION_POLICY` tek varsayımdır.

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
([ChartInputController.ts](../src/features/chart/ChartInputController.ts) :585-591): (1) event target,
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
