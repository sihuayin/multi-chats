import { expect, test } from "@playwright/test";

test.setTimeout(240_000);

test("configures an Employee Group and completes a mentioned Run", async ({
  page
}) => {
  const suffix = Date.now().toString(36);
  const employeeName = `Researcher ${suffix}`;
  const secondEmployeeName = `Writer ${suffix}`;

  await page.context().addCookies([
    {
      name: "locale",
      value: "en",
      url: "http://localhost:3000"
    }
  ]);
  await page.goto("/providers");
  await page.getByLabel("Label").fill(`Test Provider ${suffix}`);
  await page.getByLabel("API credential").fill("test-key");
  await page.getByRole("button", { name: "Validate and save" }).click();
  await expect(page.getByText("Provider saved.")).toBeVisible();
  await expect(page.getByLabel("Label")).toHaveValue("");
  await expect(page.getByLabel("API credential")).toHaveValue("");
  await expect(page.getByText(`Test Provider ${suffix}`)).toBeVisible();

  const customSkillName = `Fact Checker ${suffix}`;
  await page.goto("/skills");
  await page.getByLabel("Name").fill(customSkillName);
  await page.getByLabel("Description").fill("Checks claims against sources.");
  await page
    .getByLabel("Instructions")
    .fill("Check every claim and report uncertainty.");
  await page.getByLabel(/Fetch URL/).check();
  await page.getByLabel(/Post webhook/).check();
  await page.getByRole("button", { name: "Create custom Skill" }).click();
  await expect(page.getByText(customSkillName)).toBeVisible();

  const skillCard = page.locator(".list-card").filter({ hasText: customSkillName });
  await skillCard.getByTitle("Edit Skill").click();
  await page
    .getByLabel("Description")
    .fill("Updated custom Skill description.");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(skillCard).toContainText("Updated custom Skill description.");

  await page.goto("/employees");
  await page.getByLabel("Name").fill(employeeName);
  await page.getByLabel("Researcher").check();
  await page.getByLabel(customSkillName).check();
  const modelSelect = page.getByLabel("Model");
  await expect(modelSelect.locator("option")).not.toHaveCount(0);
  await modelSelect.selectOption({ index: 0 });
  const selectedModel = await modelSelect.inputValue();
  await expect(modelSelect.locator("option").first()).toContainText("context");
  await page.getByRole("button", { name: "Add fallback" }).click();
  const fallbackModelSelect = page.getByLabel("Model").nth(1);
  await expect(fallbackModelSelect.locator("option")).not.toHaveCount(1);
  await fallbackModelSelect.selectOption({ index: 2 });
  await page.getByRole("button", { name: "Create Employee" }).click();
  await expect(page.getByText("Employee created.")).toBeVisible();
  await expect(page.getByText(employeeName)).toBeVisible();
  await expect(
    page.locator(".list-card").filter({ hasText: employeeName })
  ).toContainText(selectedModel);
  await expect(
    page.locator(".list-card").filter({ hasText: employeeName })
  ).toContainText("Fallback targets: 1");

  await page.getByLabel("Name").fill(secondEmployeeName);
  await page.getByLabel("Writer").check();
  await page.getByRole("button", { name: "Create Employee" }).click();
  await expect(page.getByText(secondEmployeeName)).toBeVisible();

  await page.goto("/groups");
  await page.getByLabel("Group name").fill(`Research Team ${suffix}`);
  await page.getByLabel(employeeName).check();
  await page.getByLabel(secondEmployeeName).check();
  await page.getByRole("button", { name: "Create Group" }).click();
  const groupName = `Research Team ${suffix}`;
  const editedGroupName = `${groupName} V2`;
  await expect(page.getByText(groupName)).toBeVisible();

  const groupCard = page.locator(".list-card").filter({ hasText: groupName });
  let groupDialogIndex = 0;
  const groupDialogHandler = async (
    dialog: import("@playwright/test").Dialog
  ) => {
    await dialog.accept(
      groupDialogIndex === 0
        ? editedGroupName
        : `${employeeName}, ${secondEmployeeName}`
    );
    groupDialogIndex += 1;
  };
  page.on("dialog", groupDialogHandler);
  await groupCard.getByTitle("Edit Group").click();
  page.off("dialog", groupDialogHandler);
  await expect(page.getByText(editedGroupName)).toBeVisible();

  await page.goto("/");
  await page.getByTitle("New conversation").click();
  await expect(
    page.getByRole("heading", { name: `${editedGroupName} Conversation` })
  ).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollHeight <=
        window.innerHeight + 1
    )
  ).toBe(true);
  const composerBox = await page.locator(".composer").boundingBox();
  expect(composerBox).not.toBeNull();
  expect(composerBox!.y + composerBox!.height).toBeLessThanOrEqual(
    await page.evaluate(() => window.innerHeight)
  );
  const taskPanelToggle = page.getByTitle("Collapse Tasks panel");
  const conversationSurface = page.locator(".conversation-surface");
  const expandedSurfaceWidth = (await conversationSurface.boundingBox())!.width;
  await expect(taskPanelToggle).toHaveAttribute("aria-expanded", "true");
  await taskPanelToggle.click();
  await expect(page.locator(".task-panel")).toBeHidden();
  await expect(
    page.getByTitle("Expand Tasks panel")
  ).toHaveAttribute("aria-expanded", "false");
  const collapsedSurfaceWidth = (await conversationSurface.boundingBox())!.width;
  expect(collapsedSurfaceWidth).toBeGreaterThan(expandedSurfaceWidth);
  await page.getByTitle("Expand Tasks panel").click();
  await expect(page.locator(".task-panel")).toBeVisible();
  await expect(taskPanelToggle).toHaveAttribute("aria-expanded", "true");
  await page
    .getByPlaceholder("Message the group or mention @employee")
    .fill("@all prepare the launch brief");
  await page.getByRole("button", { name: "Send" }).click();

  await expect(
    page
      .locator(".message-bubble.employee")
      .filter({ hasText: `${employeeName} reviewed` })
  ).toBeVisible({ timeout: 10_000 });
  const employeeResponse = `${employeeName} reviewed the request and prepared a structured response.`;
  const secondEmployeeResponse = `${secondEmployeeName} reviewed the request and prepared a structured response.`;
  await expect(
    page
      .locator(".message-bubble.employee")
      .filter({ hasText: employeeResponse })
  ).toBeVisible({ timeout: 10_000 });
  await expect(
    page
      .locator(".message-bubble.employee")
      .filter({ hasText: secondEmployeeResponse })
  ).toBeVisible({ timeout: 10_000 });
  const employeeMessages = await page
    .locator(".message-bubble.employee")
    .allTextContents();
  expect(employeeMessages[0]).toContain(employeeResponse);
  expect(employeeMessages[1]).toContain(secondEmployeeResponse);
  await expect(page.locator(".member-turn-state.completed")).toHaveCount(2);

  await page.reload();
  await page
    .locator(".conversation-item")
    .filter({ hasText: `${editedGroupName} Conversation` })
    .click();
  await expect(
    page
      .locator(".message-bubble.employee")
      .filter({ hasText: employeeResponse })
  ).toBeVisible();
  await expect(
    page
      .locator(".message-bubble.employee")
      .filter({ hasText: secondEmployeeResponse })
  ).toBeVisible();
  await expect(
    page.locator('.run-timeline[data-run-status="completed"]')
  ).toBeVisible();
  await expect(
    page.locator('.message-bubble[data-status="streaming"]')
  ).toHaveCount(0);

  await page.getByPlaceholder("Task title").fill("Review launch brief");
  await page
    .getByPlaceholder("Goal and expected result")
    .fill("Confirm the brief is complete and consistent.");
  await page.getByRole("button", { name: "Add Task" }).click();
  await expect(page.getByText("Review launch brief")).toBeVisible();
  const taskCard = page.locator(".task-card").filter({
    hasText: "Review launch brief"
  });
  const artifactDialogs = [
    { name: "Plain notes", content: "Plain-text launch findings." },
    { name: "Markdown brief", content: "# Launch findings\n\n- Source checked" },
    { name: "JSON metrics", content: JSON.stringify({ confidence: 0.9 }) }
  ];
  let artifactDialogIndex = 0;
  const artifactDialogHandler = async (
    dialog: import("@playwright/test").Dialog
  ) => {
    const artifact = artifactDialogs[Math.floor(artifactDialogIndex / 2)];
    await dialog.accept(
      artifactDialogIndex % 2 === 0 ? artifact.name : artifact.content
    );
    artifactDialogIndex += 1;
  };
  page.on("dialog", artifactDialogHandler);
  const artifactType = taskCard.getByLabel("Artifact type");
  await artifactType.selectOption("text");
  await expect(taskCard.getByText("Plain notes")).toBeVisible();
  await artifactType.selectOption("markdown");
  await expect(taskCard.getByText("Markdown brief")).toBeVisible();
  await artifactType.selectOption("json");
  await expect(taskCard.getByText("JSON metrics")).toBeVisible();
  page.off("dialog", artifactDialogHandler);

  const textArtifact = taskCard.locator("details").filter({
    hasText: "Plain notes"
  });
  await textArtifact.locator("summary").click();
  await expect(textArtifact).toContainText("Plain-text launch findings.");
  const markdownArtifact = taskCard.locator("details").filter({
    hasText: "Markdown brief"
  });
  await markdownArtifact.locator("summary").click();
  await expect(
    markdownArtifact.getByRole("heading", { name: "Launch findings" })
  ).toBeVisible();
  const jsonArtifact = taskCard.locator("details").filter({
    hasText: "JSON metrics"
  });
  await jsonArtifact.locator("summary").click();
  await expect(jsonArtifact).toContainText('"confidence": 0.9');

  await taskCard.getByRole("button", { name: "Start" }).click();
  await expect(taskCard.locator(".status-pill.in_progress")).toBeVisible();
  await expect(
    page.locator(".message-stream").getByText("Task: Review launch brief")
  ).toBeVisible();
  await expect(page.locator(".message-bubble.employee")).toHaveCount(4, {
    timeout: 10_000
  });
  await page.reload();
  await page
    .locator(".conversation-item")
    .filter({ hasText: `${editedGroupName} Conversation` })
    .click();
  await expect(taskCard.locator(".status-pill.in_progress")).toBeVisible();
  await expect(
    page.locator(".message-stream").getByText("Task: Review launch brief")
  ).toBeVisible();
  await taskCard.getByRole("button", { name: "Block" }).click();
  await expect(taskCard.locator(".status-pill.blocked")).toBeVisible();
  await taskCard.getByRole("button", { name: "Resume" }).click();
  await expect(taskCard.locator(".status-pill.in_progress")).toBeVisible();
  await taskCard.getByRole("button", { name: "Review" }).click();
  await expect(taskCard.locator(".status-pill.review")).toBeVisible();
  await taskCard.getByRole("button", { name: "Complete" }).click();
  await expect(taskCard.locator(".status-pill.completed")).toBeVisible();

  await page.getByPlaceholder("Task title").fill("Stop and retry");
  await page
    .getByPlaceholder("Goal and expected result")
    .fill("Stop this Run and deliberately start it again.");
  await page.getByLabel(secondEmployeeName).check();
  await page.getByRole("button", { name: "Add Task" }).click();
  const retryTask = page.locator(".task-card").filter({
    hasText: "Stop and retry"
  });
  await retryTask.getByRole("button", { name: "Start" }).click();
  await retryTask.getByRole("button", { name: "Stop" }).click();
  await expect(retryTask.getByRole("button", { name: "Run again" })).toBeVisible();
  await retryTask.getByRole("button", { name: "Run again" }).click();
  await expect(retryTask.getByRole("button", { name: "Stop" })).toHaveCount(0, {
    timeout: 10_000
  });

  await page.getByPlaceholder("Task title").fill("Cancel this task");
  await page
    .getByPlaceholder("Goal and expected result")
    .fill("This Task should be cancelled.");
  await page.getByLabel(secondEmployeeName).check();
  await page.getByRole("button", { name: "Add Task" }).click();
  const cancelledTask = page.locator(".task-card").filter({
    hasText: "Cancel this task"
  });
  await expect(cancelledTask).toContainText(secondEmployeeName);
  await cancelledTask.getByRole("button", { name: "Start" }).click();
  await expect(cancelledTask.locator(".status-pill.in_progress")).toBeVisible();
  await cancelledTask.getByRole("button", { name: "Cancel" }).click();
  await expect(cancelledTask.locator(".status-pill.cancelled")).toBeVisible();

  await page.goto("/");
  await page
    .getByLabel("Conversation", { exact: true })
    .selectOption("ad-hoc");
  await page.getByTitle("New conversation").click();
  await expect(
    page.getByRole("heading", { name: "Ad hoc conversation" })
  ).toBeVisible();
  await page.getByTitle("Edit Conversation members").click();
  const memberDialog = page.getByRole("dialog");
  await memberDialog.getByPlaceholder("Search Employees").fill(employeeName);
  const memberOption = memberDialog.getByRole("option", {
    name: new RegExp(employeeName)
  });
  await memberOption.click();
  await memberOption.click();
  await memberDialog.getByRole("button", { name: "Save members" }).click();
  await expect(memberDialog).toBeHidden();
  await expect(
    page.locator(".member-stack").filter({ hasText: employeeName })
  ).toBeVisible();

  await page
    .getByPlaceholder("Message the group or mention @employee")
    .fill(`@researcher-${suffix} USE_CURRENT_TIME`);
  await page.getByRole("button", { name: "Send" }).click();
  await expect(
    page.locator(".message-bubble.employee").filter({ hasText: /Current time:/ })
  ).toBeVisible({ timeout: 10_000 });
  const toolRunTimeline = page.locator(".run-timeline");
  await toolRunTimeline.locator("summary").click();
  await expect(toolRunTimeline).toContainText("tool started");
  await expect(toolRunTimeline).toContainText("tool completed");

  await page.getByPlaceholder("Task title").fill("Approve webhook");
  await page
    .getByPlaceholder("Goal and expected result")
    .fill("Publish only after an explicit decision.");
  await page.getByRole("button", { name: "Add Task" }).click();
  const approvalTaskCard = page.locator(".task-card").filter({
    hasText: "Approve webhook"
  });
  await expect(approvalTaskCard).toBeVisible();

  await page
    .getByPlaceholder("Message the group or mention @employee")
    .fill(`@researcher-${suffix} USE_POST_WEBHOOK`);
  await page.getByRole("button", { name: "Send" }).click();
  const approvalCard = page.locator(".message-stream .approval-card");
  await expect(approvalCard).toBeVisible();
  await expect(
    approvalTaskCard.locator(".status-pill.waiting_approval")
  ).toBeVisible();
  await page.reload();
  await page.locator(".conversation-item").last().click();
  await expect(approvalCard).toBeVisible();
  await approvalCard.getByRole("button", { name: "Approve" }).click();
  await expect(
    page
      .locator(".message-bubble.employee")
      .filter({ hasText: /Tool failed: Private network URLs are not allowed/ })
  ).toBeVisible({ timeout: 10_000 });
  await expect(approvalCard).toHaveCount(0);
  await expect(approvalTaskCard.locator(".status-pill.in_progress")).toBeVisible();

  await page
    .getByPlaceholder("Message the group or mention @employee")
    .fill(`@researcher-${suffix} USE_POST_WEBHOOK`);
  await page.getByRole("button", { name: "Send" }).click();
  await expect(approvalCard).toBeVisible();
  await approvalCard.getByRole("button", { name: "Reject" }).click();
  await expect(
    page
      .locator(".message-bubble.employee")
      .filter({ hasText: /Tool failed: The user rejected this Tool call/ })
  ).toBeVisible({ timeout: 10_000 });
  await expect(toolRunTimeline).toHaveAttribute(
    "data-run-status",
    "completed"
  );
  await toolRunTimeline.locator("summary").click();
  await expect(
    toolRunTimeline.locator('[data-category="model"]')
  ).toHaveCount(1);
  await expect(
    toolRunTimeline.locator('[data-category="skill"]')
  ).not.toHaveCount(0);
  await expect(
    toolRunTimeline.locator('[data-category="tool"]')
  ).not.toHaveCount(0);
  await expect(
    toolRunTimeline.locator('[data-category="approval"]')
  ).toHaveCount(2);
  await expect(
    toolRunTimeline.locator('[data-category="approval"]').first()
  ).toContainText("Message");
  await expect(
    approvalTaskCard.locator(".status-pill.in_progress")
  ).toBeVisible();

  await page
    .getByPlaceholder("Message the group or mention @employee")
    .fill(`@researcher-${suffix} slow request`);
  await page.getByRole("button", { name: "Send" }).click();
  await expect(
    page.locator('.message-bubble[data-status="streaming"]')
  ).toBeVisible();
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(
    page.locator('.message-bubble[data-status="cancelled"]')
  ).toBeVisible();
  await page.waitForTimeout(800);
  await expect(
    page.locator('.message-bubble[data-status="cancelled"]')
  ).toBeVisible();

  await page
    .getByPlaceholder("Message the group or mention @employee")
    .fill(`@researcher-${suffix} FAIL_MODEL`);
  await page.getByRole("button", { name: "Send" }).click();
  await expect(
    page
      .locator(".message-bubble.employee")
      .filter({ hasText: "Partial failure output." })
  ).toBeVisible({ timeout: 10_000 });
  await expect(
    page.locator('.message-bubble[data-status="failed"]')
  ).toBeVisible();
  await expect(
    page.locator(".error-banner").filter({
      hasText: "model failed after partial output"
    })
  ).toBeVisible();

  await page.getByRole("tab", { name: "Discussion" }).click();
  await page.getByLabel("Discussion conversation").click();
  await page
    .getByRole("option", { name: `${editedGroupName} Conversation` })
    .click();
  await page.getByLabel("Topic").fill(`Choose the launch approach ${suffix}`);
  await page.getByLabel("Mode").click();
  await page.getByRole("option", { name: "Solution" }).click();
  await page.getByLabel("Discussion language").click();
  await page.getByRole("option", { name: "English" }).click();
  await page.getByLabel("Content rounds").fill("3");
  await page.getByLabel(`${employeeName} role`).click();
  await page.getByRole("option", { name: "Analyst" }).click();
  await page.getByLabel(`${secondEmployeeName} role`).click();
  await page.getByRole("option", { name: "Facilitator" }).click();
  await page.getByLabel("Facilitator").click();
  await page
    .getByRole("option", { name: secondEmployeeName })
    .click();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole("button", { name: "Create Discussion" }).click();
  await expect(
    page.getByRole("heading", { name: `Choose the launch approach ${suffix}` })
  ).toBeVisible();
  await page.getByRole("button", { name: "Start" }).click();
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
  await expect(
    page.getByText("Recommended option", { exact: true })
  ).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Extend" }).click();
  await expect(page.getByText("Revision 2")).toBeVisible({
    timeout: 20_000
  });
  await expect(
    page.getByText("Recommended option", { exact: true })
  ).toBeVisible();
  await page
    .getByPlaceholder("Task title override")
    .fill(`Ship the recommendation ${suffix}`);
  await page
    .getByRole("button", { name: "Confirm and create Task" })
    .click();
  await expect(page.getByText("Task created")).toBeVisible({
    timeout: 10_000
  });
  await expect(
    page.getByText(`Ship the recommendation ${suffix}`)
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true);
  await page.setViewportSize({ width: 1280, height: 900 });

  await page.goto("/employees");
  const employeeCard = page.locator(".list-card").filter({ hasText: employeeName });
  const editedEmployeeName = `${employeeName} Edited`;
  await employeeCard.getByTitle("Edit Employee").click();
  await expect(page.getByRole("heading", { name: "Edit Employee" })).toBeVisible();
  await page.getByLabel("Name").fill(editedEmployeeName);
  await page.getByLabel("Identity").fill("Updated employee identity.");
  await expect(page.getByLabel(customSkillName)).toBeChecked();
  await page.getByLabel("Writer").check();
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Employee updated.")).toBeVisible();
  await expect(page.getByLabel("Name")).toHaveValue("");
  await expect(page.getByText(editedEmployeeName)).toBeVisible();

  const editedCard = page.locator(".list-card").filter({ hasText: editedEmployeeName });
  await editedCard.getByRole("button", { name: "Disable" }).click();
  await expect(editedCard.getByRole("button", { name: "Enable" })).toBeVisible();

  await page.goto("/groups");
  await expect(
    page
      .locator(".list-card")
      .filter({ hasText: editedGroupName })
      .locator('.member-state[title="disabled"]')
  ).toHaveCount(1);

  await page.goto("/");
  await page.locator(".conversation-item").last().click();
  await expect(page.locator('.member-state[title="disabled"]')).toHaveCount(1);

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: "中文" }).click();
  await expect(page.getByRole("link", { name: "员工" })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "会话", exact: true })
  ).toBeVisible();

  await page.getByRole("button", { name: "EN", exact: true }).click();
  await expect(page.getByRole("link", { name: "Employees" })).toBeVisible();
});
