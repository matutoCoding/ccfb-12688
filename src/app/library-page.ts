import { h, clear, toast, uid } from '../lib/dom';
import { store } from '../lib/store';
import type { Clip, ColorGrade, VideoSource } from '../types';
import { importVideoFile, replaceSource, relinkClip } from '../lib/video';
import { nudgeFrame, secToTimecode, snapToFrame, formatDuration } from '../lib/timecode';
import { parseCubeLut } from '../lib/lut';
import { openClipEditor } from './clip-editor';
import { emptyState, pageHeader } from './shell';

export function libraryPage(): HTMLElement {
  const root = h('div', {});
  const draw = () => {
    const filter = { rating: 0, minDur: 0, maxDur: 9999, q: '' };
    const body = h('div', {});

    const renderGrid = () => {
      const list = store.videos.filter((v) => {
        if (filter.rating && v.rating < filter.rating) return false;
        if (v.durationSec < filter.minDur || v.durationSec > filter.maxDur) return false;
        if (filter.q && !v.name.toLowerCase().includes(filter.q.toLowerCase())) return false;
        return true;
      });
      clear(body);
      if (!list.length) {
        body.appendChild(emptyState('还没有素材。点击右上角「导入视频」，文件仅在本机处理，不会上传。'));
        return;
      }
      const grid = h('div', { class: 'grid cols-4' });
      for (const v of list) grid.appendChild(videoCard(v, renderGrid));
      body.appendChild(grid);

      const clipSection = h('div', { style: 'margin-top:28px' }, h('h2', { style: 'font-size:16px;margin:0 0 12px' }, '裁剪片段（保留源时间码）'));
      const clipTable = clipListTable();
      clipSection.appendChild(clipTable);
      body.appendChild(clipSection);
    };

    const fileInput = h('input', {
      type: 'file', accept: 'video/*', multiple: true, style: 'display:none',
      onchange: async () => {
        const files = Array.from(fileInput.files ?? []);
        for (const f of files) {
          try {
            await importVideoFile(f);
            toast(`已入库：${f.name}`);
          } catch (e) {
            toast((e as Error).message, 'warn');
          }
        }
        renderGrid();
        fileInput.value = '';
      },
    }) as HTMLInputElement;

    const lutInput = h('input', {
      type: 'file', accept: '.cube,.txt', style: 'display:none',
      onchange: async () => {
        const f = lutInput.files?.[0];
        if (!f) return;
        try {
          const lut = parseCubeLut(await f.text(), f.name.replace(/\.[^.]+$/, ''));
          await store.save('luts', lut);
          toast(`LUT 已导入：${lut.name}（${lut.size}³）`);
        } catch (e) {
          toast((e as Error).message, 'error');
        }
        lutInput.value = '';
      },
    }) as HTMLInputElement;

    const ratingSel = h('select', { onchange: () => { filter.rating = Number(ratingSel.value); renderGrid(); } },
      h('option', { value: '0' }, '全部评分'),
      [1, 2, 3, 4, 5].map((r) => h('option', { value: String(r) }, `${r} 星及以上`)),
    ) as HTMLSelectElement;

    const minDur = h('input', { type: 'number', min: '0', step: '1', placeholder: '最短(s)', oninput: () => { filter.minDur = Number(minDur.value) || 0; renderGrid(); } }) as HTMLInputElement;
    const maxDur = h('input', { type: 'number', min: '0', step: '1', placeholder: '最长(s)', oninput: () => { filter.maxDur = Number(maxDur.value) || 9999; renderGrid(); } }) as HTMLInputElement;
    const search = h('input', { placeholder: '按文件名搜索…', oninput: () => { filter.q = search.value; renderGrid(); } }) as HTMLInputElement;

    clear(root);
    root.appendChild(
      pageHeader(
        '素材库',
        '视频本地入库、逐帧裁剪与时间码管理、多套 LUT 调色对比、五星与时长组合筛选',
        h('button', { onclick: () => lutInput.click() }, '导入 LUT'),
        h('button', { class: 'primary', onclick: () => fileInput.click() }, '导入视频'),
        fileInput,
        lutInput,
      ),
    );
    root.appendChild(
      h('div', { class: 'toolbar' },
        h('div', { class: 'field grow' }, h('label', {}, '搜索'), search),
        h('div', { class: 'field' }, h('label', {}, '评分'), ratingSel),
        h('div', { class: 'field' }, h('label', {}, '最短时长'), minDur),
        h('div', { class: 'field' }, h('label', {}, '最长时长'), maxDur),
      ),
    );
    root.appendChild(body);
    renderGrid();
  };
  store.subscribe(draw);
  draw();
  return root;
}

function videoCard(v: VideoSource, refresh: () => void): HTMLElement {
  const replaceInput = h('input', {
    type: 'file', accept: 'video/*', style: 'display:none',
    onchange: async () => {
      const f = replaceInput.files?.[0];
      if (!f) return;
      try {
        await replaceSource(v.id, f);
        toast(`源文件已替换，引用片段已按同时间码自动重链：${f.name}`);
        refresh();
      } catch (e) {
        toast((e as Error).message, 'error');
      }
      replaceInput.value = '';
    },
  }) as HTMLInputElement;

  const stars = h('div', { class: 'stars' },
    ...[1, 2, 3, 4, 5].map((n) =>
      h('span', {
        class: n <= v.rating ? '' : 'off',
        onclick: async () => {
          await store.save('videos', { ...v, rating: (v.rating === n ? n - 1 : n) as VideoSource['rating'], updatedAt: Date.now() });
          refresh();
        },
      }, '★'),
    ),
  );

  return h('div', { class: 'card video-card' },
    h('img', { class: 'thumb', src: v.thumbnailDataUrl, alt: v.name }),
    h('div', { class: 'body' },
      h('div', { class: 'title', title: v.name }, v.name),
      stars,
      h('div', { class: 'meta' }, h('span', {}, formatDuration(v.durationSec)), h('span', {}, `${v.width}×${v.height} · ${v.fps.toFixed(1)}fps`)),
      h('div', { class: 'meta' }, h('span', {}, `${(v.sizeBytes / 1048576).toFixed(1)} MB`), h('span', { class: 'mono' }, v.id.slice(0, 10))),
      h('div', { class: 'pill-group', style: 'margin-top:4px' },
        h('button', { class: 'primary', onclick: () => openClipEditor(v, refresh) }, '裁剪片段'),
        h('button', { onclick: () => replaceInput.click() }, '替换重链'),
      ),
      replaceInput,
    ),
  );
}

function clipListTable(): HTMLElement {
  const clips = store.clips;
  if (!clips.length) return emptyState('暂无片段。在素材卡片上点「裁剪片段」，标记入点出点并逐帧微调。');
  const rows = clips.map((c) => {
    const src = store.videoById(c.sourceId);
    const grade = c.grades.find((g) => g.id === c.activeGradeId);
    const action = src
      ? h('button', { onclick: () => openClipEditor(src, () => store.emit(), c.id) }, '编辑')
      : h('button', {
          class: 'warn',
          onclick: () => relinkBrokenClip(c),
        }, '重新链接源文件');
    return h('tr', {},
      h('td', {}, c.name),
      h('td', { class: 'mono' }, src?.name ?? h('span', { class: 'badge danger' }, '源已断链')),
      h('td', { class: 'mono' }, secToTimecode(c.inPointSec, c.sourceFps)),
      h('td', { class: 'mono' }, secToTimecode(c.outPointSec, c.sourceFps)),
      h('td', {}, formatDuration(c.outPointSec - c.inPointSec)),
      h('td', {}, h('span', { class: grade ? 'badge accent' : 'badge' }, grade?.name ?? '原图')),
      h('td', {}, action),
    );
  });
  return h('div', { class: 'card scroll-x' }, h('table', {},
    h('thead', {}, h('tr', {}, ['片段名', '来源原片', '入点时间码', '出点时间码', '时长', '调色方案', '操作'].map((t) => h('th', {}, t)))),
    h('tbody', {}, ...rows),
  ));
}

/** 新建片段的默认对象 */
export function makeClip(source: VideoSource, inPointSec: number, outPointSec: number): Clip {
  const now = Date.now();
  const inP = snapToFrame(inPointSec, source.fps);
  const outP = snapToFrame(Math.min(outPointSec, source.durationSec), source.fps);
  const grade: ColorGrade = {
    id: uid('grade'), name: '调色方案 1', lutId: store.luts[0]?.id ?? null, strength: 1, exposure: 0, saturation: 1,
  };
  return {
    id: uid('clip'),
    name: `${source.name.replace(/\.[^.]+$/, '')}_片段${store.clips.length + 1}`,
    sourceId: source.id,
    inPointSec: inP,
    outPointSec: outP,
    sourceFps: source.fps,
    grades: [grade],
    activeGradeId: grade.id,
    createdAt: now,
    updatedAt: now,
  };
}

/** 断链片段：选择新源后按原时间码位置重链 */
async function relinkBrokenClip(clip: Clip): Promise<void> {
  if (!store.videos.length) {
    toast('素材库为空，请先导入替换用视频', 'warn');
    return;
  }
  const options = store.videos.map((v, i) => `${i + 1}. ${v.name}`).join('\n');
  const pick = prompt(`选择重链目标素材序号：\n${options}`, '1');
  const idx = Number(pick) - 1;
  const target = store.videos[idx];
  if (!target) return;
  await relinkClip(clip, target.id);
  toast(`片段已重链到 ${target.name} 的同时间码处`);
}
