/**
 * Base class for Workspace Custom Elements.
 *
 * Provides the three host-contract behaviors every element needs:
 * - a Shadow DOM root with the shared stylesheet;
 * - an `updateComplete` promise that settles when the current render/fetch
 *   cycle does (the host and tests await it);
 * - an AbortSignal that is aborted on disconnect so in-flight fetches never
 *   outlive the element.
 *
 * Rendering rule (load-bearing): API-derived strings reach the DOM only via
 * `textContent` (see `el()`); nothing in a subclass may assign `innerHTML`
 * from data.
 */
import { WORKSPACE_STYLES } from './styles';

export abstract class WorkspaceBaseElement extends HTMLElement {
  protected readonly root: ShadowRoot;
  #abort = new AbortController();
  #updateComplete: Promise<void> = Promise.resolve();

  constructor() {
    super();
    this.root = this.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = WORKSPACE_STYLES;
    this.root.append(style);
  }

  /** Settles when the in-flight render/fetch cycle does. Never rejects. */
  get updateComplete(): Promise<void> {
    return this.#updateComplete;
  }

  /** Register the current async cycle as the one `updateComplete` awaits. */
  protected track(cycle: Promise<void>): void {
    this.#updateComplete = cycle.then(
      () => undefined,
      () => undefined,
    );
  }

  /** Abort signal tied to element lifetime; fresh again after a reconnect. */
  protected get signal(): AbortSignal {
    if (this.#abort.signal.aborted) this.#abort = new AbortController();
    return this.#abort.signal;
  }

  disconnectedCallback(): void {
    this.#abort.abort();
  }

  /** Remove everything but the stylesheet. */
  protected clearContent(): void {
    for (const child of [...this.root.children]) {
      if (child.tagName !== 'STYLE') child.remove();
    }
  }

  /**
   * The one DOM construction helper: strings become `textContent`, never
   * markup.
   */
  protected el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    props: { text?: string; className?: string; attrs?: Record<string, string> } = {},
    children: Array<Node | string> = [],
  ): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (props.text !== undefined) node.textContent = props.text;
    if (props.className !== undefined) node.className = props.className;
    for (const [name, value] of Object.entries(props.attrs ?? {})) {
      node.setAttribute(name, value);
    }
    for (const child of children) {
      node.append(typeof child === 'string' ? document.createTextNode(child) : child);
    }
    return node;
  }

  protected renderStatus(message: string): void {
    this.clearContent();
    this.root.append(this.el('p', { text: message, attrs: { role: 'status' } }));
  }

  protected renderError(message: string, onRetry?: () => void): void {
    this.clearContent();
    const alert = this.el('p', { text: message, className: 'error', attrs: { role: 'alert' } });
    this.root.append(alert);
    if (onRetry) {
      const retry = this.el('button', { text: 'Retry', attrs: { type: 'button' } });
      retry.addEventListener('click', onRetry);
      this.root.append(retry);
    }
  }
}
