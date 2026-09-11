import { expect, test } from "@playwright/test";

test.setTimeout(90_000);

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
  await expect(page.getByText(`Test Provider ${suffix}`)).toBeVisible();

  const customSkillName = `Fact Checker ${suffix}`;
  await page.goto("/skills");
  await page.getByLabel("Name").fill(customSkillName);
  await page.getByLabel("Description").fill("Checks claims against sources.");
  await page
    .getByLabel("Instructions")
    .fill("Check every claim and report uncertainty.");
  await page.getByLabel(/Fetch URL/).check();
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
  await page.getByRole("button", { name: "Create Employee" }).click();
  await expect(page.getByText(employeeName)).toBeVisible();
  await expect(
    page.locator(".list-card").filter({ hasText: employeeName })
  ).toContainText(selectedModel);

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
  await page
    .getByPlaceholder("Message the group or mention @employee")
    .fill("@all prepare the launch brief");
  await page.getByRole("button", { name: "Send" }).click();

  await expect(page.getByText(`${employeeName} reviewed`)).toBeVisible({
    timeout: 10_000
  });
  const employeeResponse = `${employeeName} reviewed the request and prepared a structured response.`;
  const secondEmployeeResponse = `${secondEmployeeName} reviewed the request and prepared a structured response.`;
  await expect(page.getByText(employeeResponse)).toBeVisible({
    timeout: 10_000
  });
  await expect(page.getByText(secondEmployeeResponse)).toBeVisible({
    timeout: 10_000
  });
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
  await expect(page.getByText(employeeResponse)).toBeVisible();
  await expect(page.getByText(secondEmployeeResponse)).toBeVisible();
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

  await page.goto("/");
  await page
    .getByLabel("Conversation", { exact: true })
    .selectOption("ad-hoc");
  await page.getByTitle("New conversation").click();
  await expect(
    page.getByRole("heading", { name: "Ad hoc conversation" })
  ).toBeVisible();
  const adHocDialogHandler = async (
    dialog: import("@playwright/test").Dialog
  ) => {
    await dialog.accept(employeeName);
  };
  page.on("dialog", adHocDialogHandler);
  await page.getByTitle("Edit Conversation members").click();
  page.off("dialog", adHocDialogHandler);
  await expect(
    page.locator(".member-stack").filter({ hasText: employeeName })
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
  await expect(page.getByText("Partial failure output.")).toBeVisible({
    timeout: 10_000
  });
  await expect(
    page.locator('.message-bubble[data-status="failed"]')
  ).toBeVisible();
  await expect(
    page.getByText("model failed after partial output")
  ).toBeVisible();

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

  await page.getByRole("button", { name: "中文" }).click();
  await expect(page.getByRole("link", { name: "员工" })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "会话", exact: true })
  ).toBeVisible();

  await page.getByRole("button", { name: "EN", exact: true }).click();
  await expect(page.getByRole("link", { name: "Employees" })).toBeVisible();
});
