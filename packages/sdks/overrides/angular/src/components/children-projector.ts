import { CommonModule, isPlatformServer } from '@angular/common';
import type { TemplateRef, Type } from '@angular/core';
import {
  Component,
  Directive,
  ElementRef,
  InjectionToken,
  Injector,
  PLATFORM_ID,
  ViewChild,
  ViewContainerRef,
  inject,
  input,
  output,
  reflectComponentType,
  signal,
  untracked,
} from '@angular/core';
import { isEditing } from '../functions/is-editing';
import { isPreviewing } from '../functions/is-previewing';

const P_CLOSING_TAGS =
  'address,article,aside,blockquote,center,dd,details,dialog,dir,div,dl,dt,fieldset,figcaption,figure,footer,form,h1,h2,h3,h4,h5,h6,header,hgroup,hr,li,listing,main,menu,nav,ol,p,plaintext,pre,search,section,summary,table,ul,xmp';

const HEADING_TAGS = 'h1,h2,h3,h4,h5,h6';

const PARSER_SPECIAL_TAGS =
  'address,applet,area,article,aside,base,basefont,bgsound,blockquote,body,br,button,caption,center,col,colgroup,dd,details,dir,div,dl,dt,embed,fieldset,figcaption,figure,footer,form,frame,frameset,h1,h2,h3,h4,h5,h6,head,header,hgroup,hr,html,iframe,img,input,keygen,li,link,listing,main,marquee,menu,meta,nav,noembed,noframes,noscript,object,ol,p,param,plaintext,pre,script,section,select,source,style,summary,table,tbody,td,template,textarea,tfoot,th,thead,title,tr,track,ul,wbr,xmp';

const TABLE_CHILD_TAGS: Record<string, string[]> = {
  table: [
    'caption',
    'colgroup',
    'thead',
    'tbody',
    'tfoot',
    'script',
    'template',
    'style',
  ],
  thead: ['tr', 'script', 'template'],
  tbody: ['tr', 'script', 'template'],
  tfoot: ['tr', 'script', 'template'],
  tr: ['td', 'th', 'script', 'template'],
};

const SELECT_CHILD_TAGS = ['option', 'optgroup', 'hr', 'script', 'template'];

const TABLE_PART_PARENTS: Record<string, string[]> = {
  caption: ['table'],
  colgroup: ['table'],
  thead: ['table'],
  tbody: ['table'],
  tfoot: ['table'],
  col: ['colgroup'],
  tr: ['thead', 'tbody', 'tfoot'],
  td: ['tr'],
  th: ['tr'],
};

const IMPLIED_END_ITEMS: Record<string, string[]> = {
  li: ['li'],
  dd: ['dd', 'dt'],
  dt: ['dd', 'dt'],
};

const LIST_ITEM_SCOPE_EXCEPTIONS = ['address', 'div', 'p'];

const CELL_TAGS = ['td', 'th', 'caption', 'table'];

const FORM_CONTROL_TAGS = ['input', 'select', 'textarea', 'keygen'];

const NEAREST_TAGS = ['a', 'button', 'form', 'table'];

const CELL_CLOSING_TAGS = [
  'caption',
  'table',
  'tbody',
  'tfoot',
  'thead',
  'tr',
  'td',
  'th',
];

const SLOT_CLOSING_TAGS = new Set(
  'a,button,caption,colgroup,dd,dt,form,h1,h2,h3,h4,h5,h6,iframe,li,math,nobr,noembed,noframes,noscript,optgroup,option,p,plaintext,rb,rp,rt,rtc,script,select,style,svg,table,tbody,td,template,textarea,tfoot,th,thead,title,tr,xmp'.split(
    ','
  )
);

const tagRule = (rules: Record<string, string[]>, tag: string) =>
  Object.prototype.hasOwnProperty.call(rules, tag) ? rules[tag] : undefined;

/**
 * Marks `ngSkipHydration` on the block around markup the browser's HTML parser
 * would restructure, so server HTML that cannot hydrate is rendered again.
 */
export const markUnhydratableMarkup = (root: Element) => {
  const special = new Set(PARSER_SPECIAL_TAGS.split(','));
  const pClosing = new Set(P_CLOSING_TAGS.split(','));
  const headings = new Set(HEADING_TAGS.split(','));
  const invalid = new Set<Element>();
  const contained = new Set<Element>();
  const marked = new Set<Element>();
  const markAll = (ancestors: Element[]) => {
    for (let i = ancestors.length - 1; i >= 0; i--) {
      if (marked.has(ancestors[i])) return;
      marked.add(ancestors[i]);
      invalid.add(ancestors[i]);
    }
  };
  const nearest: Record<string, Element | null> = {
    a: null,
    button: null,
    form: null,
    table: null,
    cell: null,
    special: null,
  };
  const rootPath = new Set<Element>();
  for (let el: Element | null = root; el; el = el.parentElement) {
    rootPath.add(el);
  }
  const droppedParts = new Set<Element>();
  let tableAbove = false;
  for (const el of [...rootPath].reverse()) {
    if (!tableAbove && tagRule(TABLE_PART_PARENTS, el.localName)) {
      droppedParts.add(el);
    }
    if (el.localName === 'table') tableAbove = true;
  }
  for (const el of rootPath) {
    const tag = el.localName;
    if (NEAREST_TAGS.includes(tag) && !nearest[tag]) nearest[tag] = el;
    if (droppedParts.has(el)) continue;
    if (CELL_TAGS.includes(tag) && !nearest.cell) nearest.cell = el;
    if (special.has(tag) && !nearest.special) nearest.special = el;
  }
  const ps: Element[] = [];
  const hs: Element[] = [];
  const selects: Element[] = [];
  const selectsInTable: boolean[] = [];
  let stop: Element | null = null;
  const walk = (parent: Element) => {
    const parentTag = parent.localName;
    for (let el = parent.firstElementChild; el; el = el.nextElementSibling) {
      const tag = el.localName;
      const select = selects[selects.length - 1];
      if (pClosing.has(tag)) markAll(ps);
      if (headings.has(tag)) markAll(hs);
      if (select && FORM_CONTROL_TAGS.includes(tag)) {
        if (nearest.special === select) markAll(selects);
        else contained.add(root);
      }
      if (
        select &&
        selectsInTable[selects.length - 1] &&
        CELL_CLOSING_TAGS.includes(tag)
      ) {
        contained.add(root);
      }
      if ((tag === 'a' || tag === 'form') && nearest[tag]) {
        invalid.add(nearest[tag]!);
      }
      if (tag === 'button' && nearest.button) {
        if (nearest.special === nearest.button) invalid.add(nearest.button);
        else contained.add(root);
      }
      if (tag === 'table' && nearest.cell?.localName === 'table') {
        if (nearest.special === nearest.cell) invalid.add(nearest.cell);
        else contained.add(root);
      }
      const partParents = tagRule(TABLE_PART_PARENTS, tag);
      if (partParents && !partParents.includes(parentTag)) {
        contained.add(nearest.table ?? el);
      }
      const closes = tagRule(IMPLIED_END_ITEMS, tag);
      if (closes && stop && closes.includes(stop.localName)) {
        contained.add(root);
      }
      if (parent !== root) {
        if (parentTag === 'select' && !SELECT_CHILD_TAGS.includes(tag)) {
          contained.add(parent);
        }
        const allowed = tagRule(TABLE_CHILD_TAGS, parentTag);
        if (allowed && !allowed.includes(tag) && nearest.table) {
          contained.add(nearest.table);
        }
      }
      if (!el.firstElementChild) continue;
      const saved = { ...nearest };
      const savedStop = stop;
      const dropped = !!partParents && !saved.table;
      if (dropped) droppedParts.add(el);
      if (NEAREST_TAGS.includes(tag)) nearest[tag] = el;
      if (!dropped) {
        if (CELL_TAGS.includes(tag)) nearest.cell = el;
        if (special.has(tag)) {
          nearest.special = el;
          if (!LIST_ITEM_SCOPE_EXCEPTIONS.includes(tag)) stop = el;
        }
      }
      if (tag === 'p') ps.push(el);
      if (headings.has(tag)) hs.push(el);
      if (tag === 'select') {
        selects.push(el);
        selectsInTable.push(!!saved.cell);
      }
      walk(el);
      if (tag === 'p') ps.pop();
      if (headings.has(tag)) hs.pop();
      if (tag === 'select') {
        selects.pop();
        selectsInTable.pop();
      }
      Object.assign(nearest, saved);
      stop = savedStop;
    }
  };
  walk(root);
  const boundaries = new Map<Element, Element>();
  for (const el of invalid) {
    const path: Element[] = [];
    let boundary = el.parentElement;
    while (
      boundary &&
      boundary !== root &&
      !boundaries.has(boundary) &&
      (!special.has(boundary.localName) || droppedParts.has(boundary))
    ) {
      path.push(boundary);
      boundary = boundary.parentElement;
    }
    const found =
      boundary && boundary !== root
        ? boundaries.get(boundary) ?? boundary
        : root;
    for (const step of path) boundaries.set(step, found);
    contained.add(found);
  }
  const blocks = new Map<Element, Element>();
  for (const el of contained) {
    const path: Element[] = [];
    let block = el;
    while (
      !rootPath.has(block) &&
      block.localName !== 'block' &&
      !blocks.has(block)
    ) {
      path.push(block);
      block = block.parentElement!;
    }
    const found = blocks.get(block) ?? (rootPath.has(block) ? root : block);
    for (const step of path) blocks.set(step, found);
    found.setAttribute('ngSkipHydration', '');
  }
};

type BuilderHydrationOutlet = ReturnType<typeof createHydratingOutlet>;

export interface BuilderHydration {
  createOutlet: (
    injector: Injector,
    projectsContent: boolean
  ) => BuilderHydrationOutlet;
  markUnhydratableMarkup: (root: Element) => void;
  recordServerDecisions: (host: Element) => void;
  serverDecision: (host: Element) => boolean | undefined;
  forced: (host: Element) => boolean;
}

export const BUILDER_HYDRATION = new InjectionToken<BuilderHydration>(
  'BUILDER_HYDRATION'
);

export type BuilderHydrating = () => BuilderHydration | null;

export type BuilderBlockRenderer = Type<unknown> | undefined;

export const BUILDER_HYDRATING = new InjectionToken<BuilderHydrating>(
  'BUILDER_HYDRATING'
);

export const createBuilderHydrating = (
  compute: BuilderHydrating
): BuilderHydrating => {
  let value: BuilderHydration | null | undefined;
  return () => (value === undefined ? (value = compute()) : value);
};

export const isBuilderHydrating = ({
  hydration,
  host,
  parent,
  nested,
  hydrate,
  ssrAbTest,
  content,
}: {
  hydration: BuilderHydration | null;
  host: Element;
  parent: BuilderHydrating | null;
  nested: boolean | undefined;
  hydrate: boolean;
  ssrAbTest: boolean | undefined;
  content: { variations?: object } | undefined;
}) => {
  if (!hydration) return null;
  const server = hydration.serverDecision(host);
  if (server !== undefined) return server ? hydration : null;
  return (parent ? parent() : !nested) &&
    (nested || hydrate) &&
    content &&
    !ssrAbTest &&
    !Object.keys(content.variations || {}).length &&
    !isEditing() &&
    !isPreviewing()
    ? hydration
    : null;
};

export const injectBuilderHydrating = (): BuilderHydrating =>
  inject(BUILDER_HYDRATING, { optional: true }) ?? (() => null);

const acceptsChildrenCache = new WeakMap<object, boolean>();

const acceptsChildren = (component: any): boolean => {
  if (!component) return false;
  let accepts = acceptsChildrenCache.get(component);
  if (accepts === undefined) {
    accepts = !!reflectComponentType(component)?.inputs.some(
      (componentInput) => componentInput.templateName === 'builderChildren'
    );
    acceptsChildrenCache.set(component, accepts);
  }
  return accepts;
};

export const builderChildrenIf = (
  children: TemplateRef<any> | undefined,
  items: unknown[] | undefined | null
) => (items?.length ? children : undefined);

const useProjector = (component: any, children: TemplateRef<any> | undefined) =>
  !!children && !!component && !acceptsChildren(component);

const createBuilderChildInputs = () => {
  let lastInputs: any;
  let lastChildren: TemplateRef<any> | undefined;
  let lastResult: any;
  return (
    component: any,
    inputs: any,
    children: TemplateRef<any> | undefined
  ) => {
    if (!children || !acceptsChildren(component)) return inputs;
    if (inputs !== lastInputs || children !== lastChildren) {
      lastInputs = inputs;
      lastChildren = children;
      lastResult = { ...inputs, builderChildren: children };
    }
    return lastResult;
  };
};

const findSlotChild = (
  host: Element,
  block: { children?: { id?: string }[] } | undefined
) => {
  const ids = (block?.children ?? [])
    .map((child) => child?.id)
    .filter((id): id is string => !!id && /^[\w-]+$/.test(id));
  if (!ids.length) return null;
  let el = host.querySelector(ids.map((id) => `[builder-id="${id}"]`).join());
  while (el && el !== host && el.localName !== 'block') el = el.parentElement;
  return el === host ? null : el;
};

const clearScanMarks = (root: Element) => {
  for (const el of [root, ...Array.from(root.querySelectorAll('block'))]) {
    if (el.getAttribute('ngSkipHydration') === '') {
      el.removeAttribute('ngSkipHydration');
    }
  }
};

const skipBoundary = (host: Element, forced: WeakSet<Element>) => {
  let boundary = host.parentElement;
  while (
    boundary &&
    boundary.tagName !== 'BLOCK' &&
    boundary.tagName !== 'CONTENT-COMPONENT'
  ) {
    boundary = boundary.parentElement;
  }
  if (boundary && !forced.has(boundary)) {
    forced.add(boundary);
    boundary.setAttribute('ngSkipHydration', 'true');
  }
};

const createHydratingOutlet = (
  twins: Map<unknown, unknown>,
  projector: Type<unknown>,
  forced: WeakSet<Element>,
  stale: WeakSet<Element>,
  injector: Injector,
  projectsContent: boolean
) => {
  const childInputs = createBuilderChildInputs();
  let last: { component: any; inputs: any; children: any } | undefined;
  const twin = (component: any) => twins.get(component) ?? component;
  const isServer = isPlatformServer(injector.get(PLATFORM_ID));
  const skipsContent = projectsContent && isServer;
  const host = injector.get(ElementRef).nativeElement as Element;
  const fallback = signal(false);
  let slotChecked = false;
  return {
    twin,
    legacy: (component: any, children: TemplateRef<any> | undefined) =>
      fallback() || useProjector(twin(component), children),
    guard: (
      component: any,
      children: TemplateRef<any> | undefined,
      block: { children?: { id?: string }[] } | undefined
    ) =>
      untracked(() => {
        if (slotChecked || !children || !acceptsChildren(twin(component))) {
          return fallback();
        }
        const child = findSlotChild(host, block);
        if (!child) return false;
        slotChecked = true;
        let el = child.parentElement;
        while (el && el !== host && !SLOT_CLOSING_TAGS.has(el.localName)) {
          el = el.parentElement;
        }
        if (el && el !== host) fallback.set(true);
        return fallback();
      }),
    fellBack: () => untracked(fallback),
    rescan: () => {
      if (!isServer) return;
      let root: Element | null = null;
      for (let el = host.parentElement; el; el = el.parentElement) {
        if (el.localName === 'content-component') root = el;
      }
      if (!root || forced.has(root)) return;
      stale.add(root);
      if (root.getAttribute('ngSkipHydration') === 'true') return;
      clearScanMarks(root);
      markUnhydratableMarkup(root);
    },
    component: (component: any, children: TemplateRef<any> | undefined) => {
      const target = twin(component);
      if (!useProjector(target, children)) return target;
      if (skipsContent) {
        skipBoundary(injector.get(ElementRef).nativeElement, forced);
      }
      return projector;
    },
    inputs: (
      component: any,
      inputs: any,
      children: TemplateRef<any> | undefined
    ) => {
      const target = twin(component);
      if (!useProjector(target, children)) {
        return childInputs(target, inputs, children);
      }
      if (
        last?.component !== target ||
        last.inputs !== inputs ||
        last.children !== children
      ) {
        last = { component: target, inputs, children };
      }
      return last;
    },
  };
};

export const createBuilderHydration = (
  twins: Map<unknown, unknown>,
  projector: Type<unknown>
): BuilderHydration => {
  const serverDecisions = new WeakMap<Element, boolean>();
  const forced = new WeakSet<Element>();
  const stale = new WeakSet<Element>();
  return {
    createOutlet: (injector, projectsContent) =>
      createHydratingOutlet(
        twins,
        projector,
        forced,
        stale,
        injector,
        projectsContent
      ),
    markUnhydratableMarkup: (root) => {
      if (stale.delete(root)) clearScanMarks(root);
      markUnhydratableMarkup(root);
    },
    recordServerDecisions: (host) => {
      const editing = isEditing() || isPreviewing();
      for (const child of Array.from(host.children)) {
        if (child.tagName !== 'CONTENT-COMPONENT') continue;
        if (editing) {
          child.setAttribute('ngSkipHydration', 'true');
          child.removeAttribute('ngh');
        }
        serverDecisions.set(child, !child.hasAttribute('ngSkipHydration'));
      }
    },
    serverDecision: (host) => serverDecisions.get(host),
    forced: (host) => forced.has(host),
  };
};

export const createBuilderOutlet = (
  hydrating: BuilderHydrating,
  projectsContent = false
) => {
  const injector = inject(Injector);
  let outlet: BuilderHydrationOutlet | undefined;
  const hydratingOutlet = () => {
    const hydration = hydrating();
    return hydration
      ? (outlet ??= hydration.createOutlet(injector, projectsContent))
      : undefined;
  };
  return {
    twin: (component: any) => hydratingOutlet()?.twin(component) ?? component,
    legacy: (component: any, children: TemplateRef<any> | undefined) =>
      !!hydratingOutlet()?.legacy(component, children),
    guard: (
      component: any,
      children: TemplateRef<any> | undefined,
      block: { children?: { id?: string }[] } | undefined
    ) => !!hydratingOutlet()?.guard(component, children, block),
    fellBack: () => !!hydratingOutlet()?.fellBack(),
    rescan: () => hydratingOutlet()?.rescan(),
    component: (component: any, children: TemplateRef<any> | undefined) => {
      const target = hydratingOutlet();
      return target ? target.component(component, children) : component;
    },
    inputs: (
      component: any,
      inputs: any,
      children: TemplateRef<any> | undefined
    ) => {
      const target = hydratingOutlet();
      return target ? target.inputs(component, inputs, children) : inputs;
    },
  };
};

@Component({
  selector: 'builder-children-projector',
  standalone: true,
  imports: [CommonModule],
  host: { ngSkipHydration: 'true' },
  template: `<ng-container #childrenAnchor></ng-container
    ><ng-container
      *ngComponentOutlet="component(); inputs: inputs(); content: nodes()"
    ></ng-container>`,
  styles: [':host { display: contents; }'],
})
export default class BuilderChildrenProjector {
  component = input<any>(undefined);
  inputs = input<any>(undefined);
  children = input<TemplateRef<any> | undefined>(undefined);

  @ViewChild('childrenAnchor', { read: ViewContainerRef, static: true })
  childrenAnchor!: ViewContainerRef;

  nodes = signal<any[][] | undefined>(undefined);

  ngOnInit() {
    const children = this.children();
    if (children) {
      this.nodes.set([
        this.childrenAnchor.createEmbeddedView(children).rootNodes,
      ]);
    }
  }
}

@Directive({
  selector: '[builderLegacyAnchor]',
  standalone: true,
  exportAs: 'builderLegacyAnchor',
})
export class BuilderLegacyAnchor {
  readonly viewContainer = inject(ViewContainerRef);
}

/**
 * In-place variant of `builder-children-projector` for a component template
 * root: renders the children at `builderLegacyChildrenAt`, after the sibling
 * `ngComponentOutlet`, for projection into it (a component without
 * `<ng-content>` keeps them after itself, as 0.26.2 did), and on the server
 * marks the enclosing component host `ngSkipHydration`, so no wrapper element
 * is added around the target.
 */
@Directive({
  selector: '[builderLegacyChildren]',
  standalone: true,
  exportAs: 'builderLegacyChildren',
})
export class BuilderLegacyChildren {
  children = input<TemplateRef<any> | undefined>(undefined, {
    alias: 'builderLegacyChildren',
  });
  at = input.required<BuilderLegacyAnchor>({
    alias: 'builderLegacyChildrenAt',
  });
  nodes: any[][] | undefined;
  readonly done = output<Element | null>({ alias: 'builderLegacyRendered' });

  private readonly anchor = inject(ElementRef);
  private readonly isServer = isPlatformServer(inject(PLATFORM_ID));
  private rendered: TemplateRef<any> | undefined;

  ngOnChanges() {
    const children = this.children();
    if (children === this.rendered) return;
    this.rendered = children;
    const viewContainer = this.at().viewContainer;
    viewContainer.clear();
    this.nodes = children
      ? [viewContainer.createEmbeddedView(children).rootNodes]
      : undefined;
    if (this.isServer) {
      (this.anchor.nativeElement as Node).parentElement?.setAttribute(
        'ngSkipHydration',
        ''
      );
    }
  }

  ngAfterViewInit() {
    this.done.emit((this.anchor.nativeElement as Comment).nextElementSibling);
  }
}
