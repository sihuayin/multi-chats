import { expect, test } from "@playwright/test";

test.setTimeout(90_000);

test("configures an Employee Group and completes a mentioned Run", async ({
  page
}) => {
  const suffix = Date.now().toString(36);
  const employeeName = `Researcher ${suffix}`;

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

  await page.goto("/employees");
  await page.getByLabel("Name").fill(employeeName);
  await page.getByLabel("Researcher").check();
  await expect(page.getByLabel("Model").locator("option")).not.toHaveCount(0);
  await page.getByRole("button", { name: "Create Employee" }).click();
  await expect(page.getByText(employeeName)).toBeVisible();

  await page.goto("/groups");
  await page.getByLabel("Group name").fill(`Research Team ${suffix}`);
  await page.getByLabel(employeeName).check();
  await page.getByRole("button", { name: "Create Group" }).click();
  await expect(page.getByText(`Research Team ${suffix}`)).toBeVisible();

  await page.goto("/");
  await page.getByTitle("New conversation").click();
  await expect(
    page.getByRole("heading", { name: `Research Team ${suffix} Conversation` })
  ).toBeVisible();
  await page
    .getByPlaceholder("Message the group or mention @employee")
    .fill(`@researcher-${suffix} prepare the launch brief`);
  await page.getByRole("button", { name: "Send" }).click();

  await expect(
    page.getByText(`${employeeName} reviewed the request and prepared a structured response.`)
  ).toBeVisible({ timeout: 10_000 });

  await page.getByPlaceholder("Task title").fill("Review launch brief");
  await page
    .getByPlaceholder("Goal and expected result")
    .fill("Confirm the brief is complete and consistent.");
  await page.getByRole("button", { name: "Add Task" }).click();
  await expect(page.getByText("Review launch brief")).toBeVisible();

  await page.getByRole("button", { name: "中文" }).click();
  await expect(page.getByRole("link", { name: "员工" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "会话" })).toBeVisible();

  await page.getByRole("button", { name: "EN", exact: true }).click();
  await expect(page.getByRole("link", { name: "Employees" })).toBeVisible();
});
