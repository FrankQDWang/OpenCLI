import { buildFindJs, buildSemanticFindJs, type SemanticFindOptions } from './find.js';
import { Page } from './page.js';

export const BROWSER_OPERATION_ACTION = 'browser-operation';

const BROWSER_OPERATIONS = new Set([
  'state',
  'get-url',
  'evaluate',
  'find-css',
  'find-semantic',
  'click',
  'fill',
  'scroll',
  'wait',
]);

export interface BrowserOperationCommand {
  id: string;
  action: typeof BROWSER_OPERATION_ACTION;
  operation: string;
  session: string;
  page?: string;
  idleTimeout?: number;
  windowMode?: 'foreground' | 'background';
  surface?: 'browser' | 'adapter';
  siteSession?: 'ephemeral' | 'persistent';
  controlKey?: string;
  fenceToken?: number;
  code?: string;
  selector?: string;
  semantic?: SemanticFindOptions;
  limit?: number;
  textMax?: number;
  target?: string;
  text?: string;
  direction?: 'up' | 'down';
  amount?: number;
  waitKind?: 'time' | 'text' | 'selector';
  waitValue?: string | number;
  waitTimeout?: number;
}

export interface BrowserOperationResult {
  data: unknown;
  page?: string;
  idleDeadlineAt?: number;
}

export interface BrowserOperationFailure {
  errorCode: string;
  error: string;
  errorHint?: string;
}

type BrowserOperationPage = Pick<
  Page,
  | 'click'
  | 'evaluate'
  | 'evaluateWithMetadata'
  | 'fillText'
  | 'getActivePage'
  | 'getCurrentUrl'
  | 'scroll'
  | 'setActivePage'
  | 'snapshot'
  | 'wait'
>;

type PageFactory = (command: BrowserOperationCommand, contextId: string) => BrowserOperationPage;

export async function runBrowserOperation(
  rawCommand: unknown,
  contextId: string,
  pageFactory: PageFactory = createPage,
): Promise<BrowserOperationResult> {
  const command = validateBrowserOperationCommand(rawCommand);
  const page = pageFactory(command, contextId);
  if (command.page) page.setActivePage(command.page);

  let data: unknown;
  let idleDeadlineAt: number | undefined;
  switch (command.operation) {
    case 'state': {
      const snapshot = await page.snapshot({ viewportExpand: 2000, source: 'dom' });
      const url = await page.getCurrentUrl() ?? '';
      const text = typeof snapshot === 'string' ? snapshot : JSON.stringify(snapshot, null, 2);
      data = `URL: ${url}\n\n${text}`;
      break;
    }
    case 'get-url':
      data = await page.getCurrentUrl() ?? '';
      break;
    case 'evaluate': {
      const result = await page.evaluateWithMetadata(requireString(command.code, 'code'));
      data = result.data;
      idleDeadlineAt = result.idleDeadlineAt;
      break;
    }
    case 'find-css':
      data = await page.evaluate(buildFindJs(requireString(command.selector, 'selector'), {
        limit: positiveBoundedInt(command.limit, 'limit', 1, 100),
        textMax: positiveBoundedInt(command.textMax, 'textMax', 1, 10_000),
      }));
      break;
    case 'find-semantic':
      data = await page.evaluate(buildSemanticFindJs(validateSemantic(command.semantic, command.limit, command.textMax)));
      break;
    case 'click': {
      const target = requireString(command.target, 'target');
      const result = await page.click(target);
      data = { clicked: true, target, ...result };
      break;
    }
    case 'fill': {
      const target = requireString(command.target, 'target');
      const text = requireString(command.text, 'text', true);
      const result = await page.fillText(target, text);
      data = { target, text, ...result };
      break;
    }
    case 'scroll': {
      if (command.direction !== 'up' && command.direction !== 'down') throw invalidField('direction');
      const amount = positiveBoundedInt(command.amount, 'amount', 1, 10_000);
      await page.scroll(command.direction, amount);
      data = { scrolled: command.direction, amount };
      break;
    }
    case 'wait':
      data = await runWait(page, command);
      break;
    default:
      throw invalidField('operation');
  }

  const activePage = page.getActivePage();
  return {
    data,
    ...(activePage ? { page: activePage } : {}),
    ...(idleDeadlineAt !== undefined ? { idleDeadlineAt } : {}),
  };
}

export function browserOperationFailure(error: unknown): BrowserOperationFailure {
  const value = error as { code?: unknown; hint?: unknown; message?: unknown };
  const errorCode = typeof value?.code === 'string' && value.code.trim()
    ? value.code.trim().toLowerCase().replaceAll('-', '_')
    : 'browser_operation_failed';
  const message = typeof value?.message === 'string' && value.message.trim()
    ? value.message.trim()
    : String(error);
  const hint = typeof value?.hint === 'string' && value.hint.trim() ? value.hint.trim() : undefined;
  return { errorCode, error: message, ...(hint ? { errorHint: hint } : {}) };
}

function createPage(command: BrowserOperationCommand, contextId: string): Page {
  return new Page(
    command.session,
    command.idleTimeout,
    contextId,
    command.windowMode,
    command.surface ?? 'browser',
    command.siteSession,
    undefined,
    command.controlKey,
    command.fenceToken,
  );
}

function validateBrowserOperationCommand(raw: unknown): BrowserOperationCommand {
  if (!raw || typeof raw !== 'object') throw invalidField('command');
  const command = raw as Partial<BrowserOperationCommand>;
  if (command.action !== BROWSER_OPERATION_ACTION) throw invalidField('action');
  if (typeof command.operation !== 'string' || !BROWSER_OPERATIONS.has(command.operation)) {
    throw invalidField('operation');
  }
  requireString(command.id, 'id');
  requireString(command.session, 'session');
  if (command.page !== undefined) requireString(command.page, 'page');
  if (command.windowMode !== undefined && command.windowMode !== 'foreground' && command.windowMode !== 'background') {
    throw invalidField('windowMode');
  }
  if (command.surface !== undefined && command.surface !== 'browser' && command.surface !== 'adapter') {
    throw invalidField('surface');
  }
  if (command.fenceToken !== undefined && (!Number.isSafeInteger(command.fenceToken) || command.fenceToken <= 0)) {
    throw invalidField('fenceToken');
  }
  if ((command.controlKey === undefined) !== (command.fenceToken === undefined)) throw invalidField('control fence');
  if (command.controlKey !== undefined) requireString(command.controlKey, 'controlKey');
  return command as BrowserOperationCommand;
}

function validateSemantic(
  value: SemanticFindOptions | undefined,
  rawLimit: number | undefined,
  rawTextMax: number | undefined,
): SemanticFindOptions {
  if (!value || typeof value !== 'object') throw invalidField('semantic');
  const semantic: SemanticFindOptions = {};
  for (const key of ['role', 'name', 'label', 'text', 'testid'] as const) {
    const field = value[key];
    if (field !== undefined) semantic[key] = requireString(field, `semantic.${key}`);
  }
  if (!semantic.role && !semantic.name && !semantic.label && !semantic.text && !semantic.testid) {
    throw invalidField('semantic');
  }
  semantic.limit = positiveBoundedInt(rawLimit, 'limit', 1, 100);
  semantic.textMax = positiveBoundedInt(rawTextMax, 'textMax', 1, 10_000);
  return semantic;
}

async function runWait(page: BrowserOperationPage, command: BrowserOperationCommand): Promise<object> {
  if (command.waitKind === 'time') {
    if (typeof command.waitValue !== 'number' || command.waitValue < 0 || command.waitValue > 10) {
      throw invalidField('waitValue');
    }
    await page.wait(command.waitValue);
    return { waited: command.waitValue };
  }
  if (command.waitKind !== 'text' && command.waitKind !== 'selector') throw invalidField('waitKind');
  const value = requireString(command.waitValue, 'waitValue');
  const timeout = positiveBoundedInt(command.waitTimeout, 'waitTimeout', 1, 120);
  await page.wait(command.waitKind === 'text' ? { text: value, timeout } : { selector: value, timeout });
  return { waitedFor: command.waitKind, value };
}

function positiveBoundedInt(value: unknown, field: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) throw invalidField(field);
  return Number(value);
}

function requireString(value: unknown, field: string, allowEmpty = false): string {
  if (typeof value !== 'string' || value.includes('\0') || (!allowEmpty && !value.trim())) throw invalidField(field);
  return value;
}

function invalidField(field: string): Error & { code: string } {
  return Object.assign(new Error(`Invalid browser operation field: ${field}`), { code: 'invalid_browser_operation' });
}
