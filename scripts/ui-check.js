async (page) => {
  // Run with playwright-cli run-code --filename scripts/ui-check.js after the manual import flow.
  const frame = page.locator('#panel').contentFrame();
  const before = await frame.getByRole('textbox', { name: '编辑 想法与要求' }).inputValue();
  if (!before.includes('保留已确认')) throw new Error('Widget has not received full-view changes');
  await page.reload();
  const panel = page.locator('#panel').contentFrame();
  await panel.getByRole('textbox', { name: '编辑 想法与要求' }).waitFor();
  if ((await panel.getByRole('textbox', { name: '编辑 想法与要求' }).inputValue()) !== before)
    throw new Error('Text lost after reload');
  if (
    !(await panel.getByRole('textbox', { name: '给 AI 的指令' }).inputValue()).includes(
      '保留已确认',
    )
  )
    throw new Error('Instruction lost after reload');
  if (!(await panel.getByRole('button', { name: '发送 ↗' }).isDisabled()))
    throw new Error('Unsafe send enabled');
  const images = await panel.getByRole('img', { name: 'reference-1.png' }).count();
  if (images !== 1) throw new Error('Image did not restore');
  await panel.getByRole('button', { name: '展开 reference-1.png' }).click();
  await panel.getByRole('button', { name: '矩形批注', exact: true }).click();
  await panel.getByRole('textbox', { name: '批注内容' }).fill('保留这个区域');
  const img = panel
    .getByRole('dialog', { name: 'reference-1.png' })
    .getByRole('img', { name: 'reference-1.png' });
  const box = await img.boundingBox();
  if (!box) throw new Error('Image has no dimensions');
  await page.mouse.move(box.x + box.width * 0.1, box.y + box.height * 0.1);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.6, { steps: 8 });
  await page.mouse.up();
  await panel.getByText('保留这个区域', { exact: true }).first().waitFor();
  await panel.getByRole('button', { name: '← 返回桌面' }).click();
  await panel.getByRole('button', { name: 'Fit View', exact: true }).click();
  console.log(
    'PASS: full view shares object; text/image/instruction survive reload; annotation returns to widget; unverified send disabled.',
  );
};
