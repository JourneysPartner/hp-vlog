'use strict';

class FakeClassList {
  constructor(element) { this.element = element; }
  values() { return new Set(String(this.element.className || '').split(/\s+/).filter(Boolean)); }
  write(values) { this.element.className = [...values].join(' '); }
  add(...names) { const values = this.values(); names.forEach(name => values.add(name)); this.write(values); }
  remove(...names) { const values = this.values(); names.forEach(name => values.delete(name)); this.write(values); }
  contains(name) { return this.values().has(name); }
  toggle(name, force) {
    const values = this.values();
    const enabled = force === undefined ? !values.has(name) : Boolean(force);
    if (enabled) values.add(name); else values.delete(name);
    this.write(values);
    return enabled;
  }
}

class FakeNode {
  constructor(tagName, ownerDocument, nodeType = 1) {
    this.tagName = tagName ? String(tagName).toUpperCase() : '';
    this.ownerDocument = ownerDocument;
    this.nodeType = nodeType;
    this.children = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.listeners = new Map();
    this.className = '';
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.isConnected = true;
    this._text = '';
    this.classList = new FakeClassList(this);
  }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  setAttribute(name, value) {
    const stringValue = String(value);
    this.attributes.set(name, stringValue);
    if (name === 'class') this.className = stringValue;
    if (name === 'id') this.id = stringValue;
    if (name === 'value') this.value = stringValue;
    if (name === 'checked') this.checked = true;
    if (name === 'disabled') this.disabled = true;
  }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  hasAttribute(name) { return this.attributes.has(name); }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  removeEventListener(name) { this.listeners.delete(name); }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
  replaceChildren(...children) {
    this.children.forEach(child => { child.isConnected = false; child.parentNode = null; });
    this.children = [];
    this._text = '';
    children.forEach(child => this.appendChild(child));
  }
  focus(options) { this.focusOptions = options; this.ownerDocument.activeElement = this; }
  getBoundingClientRect() { return { top: 120 }; }
  querySelector(selector) {
    const finalSelector = selector.trim().split(/\s+/).at(-1);
    const match = node => finalSelector.startsWith('.')
      ? node.classList.contains(finalSelector.slice(1))
      : finalSelector.startsWith('#')
        ? node.id === finalSelector.slice(1)
        : node.tagName.toLowerCase() === finalSelector.toLowerCase();
    const visit = node => {
      for (const child of node.children) {
        if (match(child)) return child;
        const found = visit(child);
        if (found) return found;
      }
      return null;
    };
    return visit(this);
  }
}

function createFakeDom() {
  const windowObject = {
    scrollY: 0,
    addEventListener() {},
    removeEventListener() {},
    confirm() { return true; },
    scrollTo() {},
  };
  const documentObject = {
    defaultView: windowObject,
    activeElement: null,
    createElement(tagName) { return new FakeNode(tagName, documentObject); },
    createTextNode() { return new FakeNode('', documentObject, 3); },
    querySelector() { return null; },
  };
  documentObject.body = documentObject.createElement('body');
  return {
    document: documentObject,
    root: documentObject.createElement('div'),
    intro: documentObject.createElement('section'),
  };
}

function withFakeDocument(action) {
  const previous = global.document;
  const dom = createFakeDom();
  global.document = dom.document;
  try { return action(dom); }
  finally {
    if (previous === undefined) delete global.document;
    else global.document = previous;
  }
}

module.exports = Object.freeze({ createFakeDom, withFakeDocument });
