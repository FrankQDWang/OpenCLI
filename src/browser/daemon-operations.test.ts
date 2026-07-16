import { describe, expect, it } from 'vitest';
import { Page } from './page.js';
import {
  BROWSER_OPERATION_ACTION,
  browserOperationFailure,
  runBrowserOperation,
} from './daemon-operations.js';

class FakePage {
  activePage: string | undefined;
  evaluated: string[] = [];
  fillVerified = true;
  waits: unknown[] = [];

  setActivePage(page?: string): void {
    this.activePage = page;
  }

  getActivePage(): string | undefined {
    return this.activePage;
  }

  async snapshot(): Promise<string> {
    return '[1] button "Search"';
  }

  async getCurrentUrl(): Promise<string> {
    return 'https://example.com/search';
  }

  async evaluate(code: string): Promise<unknown> {
    this.evaluated.push(code);
    return { matches_n: 1, entries: [{ ref: 1 }] };
  }

  async evaluateWithMetadata(code: string): Promise<{
    data: unknown;
    page?: string;
    idleDeadlineAt?: number;
  }> {
    this.evaluated.push(code);
    return {
      data: { matches_n: 1, entries: [{ ref: 1 }] },
      page: this.activePage,
      idleDeadlineAt: 123456,
    };
  }

  async click(target: string): Promise<{ matches_n: number; match_level: 'exact' }> {
    return { matches_n: target === '1' ? 1 : 0, match_level: 'exact' };
  }

  async fillText(target: string, text: string): Promise<{
    matches_n: number;
    match_level: 'exact';
    filled: boolean;
    verified: boolean;
    expected: string;
    actual: string;
    length: number;
  }> {
    return {
      matches_n: target === '2' ? 1 : 0,
      match_level: 'exact',
      filled: true,
      verified: this.fillVerified,
      expected: text,
      actual: this.fillVerified ? text : '',
      length: this.fillVerified ? text.length : 0,
    };
  }

  async scroll(): Promise<void> {}

  async wait(options: unknown): Promise<void> {
    this.waits.push(options);
  }
}

function command(operation: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'command-1',
    action: BROWSER_OPERATION_ACTION,
    operation,
    session: 'session-1',
    page: 'page-1',
    ...extra,
  };
}

function factory(page: FakePage): () => Page {
  return () => page as unknown as Page;
}

describe('daemon browser operations', () => {
  it('returns the existing state format and command metadata', async () => {
    const page = new FakePage();

    await expect(runBrowserOperation(command('state'), 'profile-1', factory(page))).resolves.toEqual({
      data: 'URL: https://example.com/search\n\n[1] button "Search"',
      page: 'page-1',
    });
  });

  it('uses OpenCLI find builders inside the long-lived daemon', async () => {
    const page = new FakePage();

    await runBrowserOperation(command('find-css', {
      selector: '#resultList .card',
      limit: 20,
      textMax: 1200,
    }), 'profile-1', factory(page));
    await runBrowserOperation(command('find-semantic', {
      semantic: { role: 'button', name: 'Search' },
      limit: 10,
      textMax: 120,
    }), 'profile-1', factory(page));

    expect(page.evaluated[0]).toContain('#resultList .card');
    expect(page.evaluated[1]).toContain('Search');
  });

  it('preserves the extension idle deadline for evaluate operations', async () => {
    const page = new FakePage();

    await expect(runBrowserOperation(command('evaluate', { code: 'document.title' }), 'profile-1', factory(page)))
      .resolves.toEqual({
        data: { matches_n: 1, entries: [{ ref: 1 }] },
        page: 'page-1',
        idleDeadlineAt: 123456,
      });
  });

  it('delegates click, fill, and waits to Page without CLI parsing', async () => {
    const page = new FakePage();

    await expect(runBrowserOperation(command('click', { target: '1' }), 'profile-1', factory(page)))
      .resolves.toMatchObject({ data: { clicked: true, target: '1', matches_n: 1 } });
    await expect(runBrowserOperation(command('fill', { target: '2', text: 'engineer' }), 'profile-1', factory(page)))
      .resolves.toMatchObject({ data: { target: '2', verified: true, actual: 'engineer' } });
    await runBrowserOperation(command('wait', {
      waitKind: 'selector',
      waitValue: '#resultList',
      waitTimeout: 30,
    }), 'profile-1', factory(page));

    expect(page.waits).toEqual([{ selector: '#resultList', timeout: 30 }]);
  });

  it('rejects a fill whose final value could not be verified', async () => {
    const page = new FakePage();
    page.fillVerified = false;

    await expect(runBrowserOperation(
      command('fill', { target: '2', text: 'private-input' }),
      'profile-1',
      factory(page),
    )).rejects.toMatchObject({ code: 'fill_verification_failed' });

    const failure = browserOperationFailure(await runBrowserOperation(
      command('fill', { target: '2', text: 'private-input' }),
      'profile-1',
      factory(page),
    ).catch((error: unknown) => error));
    expect(failure.errorCode).toBe('fill_verification_failed');
    expect(failure.error).not.toContain('private-input');
  });

  it('rejects malformed control fences before touching a page', async () => {
    await expect(runBrowserOperation(command('get-url', { controlKey: 'lane' }), 'profile-1'))
      .rejects.toMatchObject({ code: 'invalid_browser_operation' });
  });

  it('preserves structured target errors for daemon responses', () => {
    expect(browserOperationFailure(Object.assign(new Error('missing'), {
      code: 'selector-not-found',
      hint: 'refresh state',
    }))).toEqual({
      errorCode: 'selector_not_found',
      error: 'missing',
      errorHint: 'refresh state',
    });
  });
});
