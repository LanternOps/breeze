import type { Page, Response } from '@playwright/test';
import { BasePage } from './BasePage';
import { waitForAppReady, waitForHydration } from './hydration';

/**
 * Page Objects for the AI Operator delegate flow (#5205 W08, #5246).
 *
 * Two surfaces, kept in one file because the spec drives them as one flow:
 * the "Delegate to Operator" action that lives on the device detail page, and
 * the task detail page it navigates to.
 */

/** The "Delegate to Operator" action, wherever it is rendered. */
export class DelegateToOperatorAction extends BasePage {
  button = () => this.page.getByTestId('delegate-to-operator');
  serviceInput = () => this.page.getByTestId('delegate-to-operator-service');
  confirmButton = () => this.page.getByTestId('delegate-to-operator-confirm');
  validationError = () => this.page.getByTestId('delegate-to-operator-error');

  /** Opens the device detail page and waits for the action to be clickable. */
  async gotoDevice(deviceId: string) {
    await this.page.goto(`/devices/${deviceId}`);
    await this.button().waitFor({ timeout: 30_000 });
    await waitForHydration(this.page, 'delegate-to-operator');
  }

  async openDialog() {
    await this.button().click();
    await this.serviceInput().waitFor();
  }

  /**
   * Fills the service name and confirms, returning the admission response.
   *
   * The task id is read from the `POST /ai/operator/tasks` response rather
   * than scraped from the URL: the URL is the thing under test (the action
   * must navigate to the task the SERVER created), so reading the id from it
   * would make the navigation assertion circular.
   */
  async confirm(serviceName: string): Promise<{ status: number; taskId: string; request: DelegateRequest }> {
    await this.serviceInput().fill(serviceName);

    let captured: DelegateRequest | null = null;
    const onRequest = (req: { url(): string; method(): string; headers(): Record<string, string>; postData(): string | null }) => {
      if (req.method() === 'POST' && req.url().includes('/ai/operator/tasks')) {
        captured = {
          url: req.url(),
          headers: req.headers(),
          body: req.postData() ?? '',
        };
      }
    };
    this.page.on('request', onRequest);

    let response: Response;
    try {
      [response] = await Promise.all([
        this.page.waitForResponse(
          (r) => r.url().includes('/ai/operator/tasks') && r.request().method() === 'POST',
          { timeout: 30_000 },
        ),
        this.confirmButton().click(),
      ]);
    } finally {
      this.page.off('request', onRequest);
    }

    const body = (await response.json()) as { taskId?: string };
    if (!captured) throw new Error('never observed the delegate POST request');
    if (!body.taskId) throw new Error(`admission returned no taskId: ${JSON.stringify(body)}`);
    return { status: response.status(), taskId: body.taskId, request: captured };
  }
}

export type DelegateRequest = {
  url: string;
  headers: Record<string, string>;
  body: string;
};

/** The AI Operator task detail page at /operator/tasks/<id>. */
export class OperatorTaskPage extends BasePage {
  state = () => this.page.getByTestId('operator-task-state');
  nextAction = () => this.page.getByTestId('operator-task-next-action');
  target = () => this.page.getByTestId('operator-task-target');
  operationsList = () => this.page.getByTestId('operator-task-operations-list');
  operationsEmpty = () => this.page.getByTestId('operator-task-operations-empty');
  error = () => this.page.getByTestId('operator-task-error');

  async goto(taskId: string) {
    await this.page.goto(`/operator/tasks/${taskId}`);
    await waitForAppReady(this.page, 'operator-task-state');
  }

  /** Waits for the detail page to finish loading after an in-app navigation. */
  async waitForLoaded() {
    await waitForAppReady(this.page, 'operator-task-state');
  }
}

/** The approvals inbox at /approvals. */
export class ApprovalsInboxPage extends BasePage {
  url = '/approvals';

  inbox = () => this.page.getByTestId('approvals-inbox');
  row = (approvalId: string) => this.page.getByTestId(`approval-row-${approvalId}`);
  approveButton = (approvalId: string) => this.page.getByTestId(`approval-approve-${approvalId}`);

  async goto() {
    await this.page.goto(this.url);
    await waitForAppReady(this.page, 'approvals-inbox');
  }

  async approve(approvalId: string): Promise<number> {
    await this.row(approvalId).waitFor({ timeout: 30_000 });
    const [response] = await Promise.all([
      this.page.waitForResponse(
        (r) => r.url().includes(`/approvals/${approvalId}/approve`) && r.request().method() === 'POST',
        { timeout: 30_000 },
      ),
      this.approveButton(approvalId).click(),
    ]);
    return response.status();
  }
}

export function delegateAction(page: Page): DelegateToOperatorAction {
  return new DelegateToOperatorAction(page);
}
