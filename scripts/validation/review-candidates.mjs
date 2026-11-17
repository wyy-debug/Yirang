// Draft inputs for independent human annotation; never invent reviewer labels.
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
const directory = resolve(process.argv[2] || 'docs/review/bot-routing-20261101');
const themes = [
  ['季度销售报告', '销售预算', '华东', '华南'],
  ['产品发布方案', '推广预算', '线上', '线下'],
  ['旅行计划', '交通预算', '南京', '杭州'],
  ['采购计划', '采购预算', '办公室', '仓库'],
  ['培训方案', '培训预算', '研发组', '运营组'],
];
const cases = [];
for (const [group, [title, budget, left, right]] of themes.entries()) {
  const templates = [
    `新建一份${title}，不要沿用之前的草稿。`,
    `解释一下“${budget}”是什么意思，只回答，不制作文档。`,
    `把${left}${title}的${budget}上限改为8000元，其余要求不变。`,
    `不要改${left}${title}的金额，只把标题中的“初稿”改成“终稿”。`,
    `查询${left}${title}的当前进度，不要继续执行。`,
    `暂停${left}${title}，${right}${title}照常。`,
    `取消${left}${title}，不要删除已经生成的文件。`,
    `恢复之前暂停的${left}${title}，保留已确认的要求。`,
    `预算确定为8000元。`,
    `收到，谢谢。暂时不用做任何事。`,
    `新建${title}；另外新建一份会议议程。`,
    `不要新建文件。只解释“${left}${title}”中“预算”这个概念。`,
    `新建标题为“${title}🧭”的文字文档，原样保留 café 和 é。`,
    `新建说明文档，引用“取消${left}${title}”这句话，不要真的取消工作。`,
    `继续等待${left}${title}的结果，只告诉我预计还需要做哪些步骤，不修改要求。`,
    `修改${right}${title}，只保留两页；${left}${title}的要求不变。`,
    `先取消${left}${title}，确认停止后再新建替代方案。`,
    `关于${left}${title}，把预算改成9000元；对，就是该方案，不是${right}那份。`,
    `把那个方案改成英文。`,
    `照刚才说的继续。`,
    `那个预算不对，你改一下。`,
    `就选第二个吧。`,
    `这份材料也按原来的方法处理。`,
    `那边改了，这边也同步一下。`,
  ];
  for (const [family, input] of templates.entries()) {
    const id = `R${String(group * 24 + family + 1).padStart(3, '0')}`;
    const tasks = [
      {
        id: 'task-a',
        title: left + title,
        revision: 4,
        state: family === 7 ? 'paused' : 'queued',
        requirements: `制作${left}${title}，保留来源和已有成果。`,
        questionId: family === 8 ? 'question-a' : null,
        question: family === 8 ? '请确认预算上限是多少？' : null,
      },
      {
        id: 'task-b',
        title: right + title,
        revision: 7,
        state: 'queued',
        requirements: `制作${right}${title}，不得复用${left}数据。`,
        questionId: null,
        question: null,
      },
    ];
    const source = { input, tasks, files: [], conversationFacts: [] };
    cases.push({
      id,
      familyId: `F${String(family + 1).padStart(2, '0')}`,
      sourceHash: createHash('sha256').update(JSON.stringify(source)).digest('hex'),
      ...source,
      textLength: input.length,
    });
  }
}
await mkdir(directory, { recursive: true });
const write = (name, value) =>
  writeFile(join(directory, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
await write('inputs.json', {
  format: 'yirang-routing-review-draft',
  version: 1,
  status: 'unreviewed-not-certified',
  purpose: '120 candidate cases; not a frozen acceptance set',
  cases,
});
for (const reviewer of ['a', 'b'])
  await write(`reviewer-${reviewer}.json`, {
    reviewerId: null,
    reviewedAt: null,
    independent: null,
    entries: cases.map((c) => ({
      caseId: c.id,
      sourceHash: c.sourceHash,
      actions: null,
      acceptableAlternatives: [],
      notes: null,
    })),
  });
await write('adjudication.json', {
  reviewerId: null,
  status: 'pending-both-independent-reviews',
  entries: cases.map((c) => ({
    caseId: c.id,
    sourceHash: c.sourceHash,
    finalActions: null,
    rationale: null,
  })),
});
console.log(`Created ${cases.length} unlabelled review candidates at ${directory}`);
