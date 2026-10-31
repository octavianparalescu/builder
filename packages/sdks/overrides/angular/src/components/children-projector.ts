import { CommonModule, isPlatformServer } from '@angular/common';
import type { TemplateRef, Type } from '@angular/core';
import {
  Component,
  Directive,
  ElementRef,
  InjectionToken,
  Injector,
  PLATFORM_ID,
  VERSION,
  ViewChild,
  ViewContainerRef,
  inject,
  input,
  reflectComponentType,
  signal,
} from '@angular/core';
import { isEditing } from '../functions/is-editing';
import { isPreviewing } from '../functions/is-previewing';

declare module '../types/components' {
  interface ComponentInfo {
    /**
     * Angular, in content rendered with `[hydrate]="true"`: pass the block's
     * children to the component's `builderChildren` input so they hydrate.
     * Set it only when no element the HTML parser closes early or restructures
     * (`a`, `button`, `form`, `h1`-`h6`, `li`, `p`, `select`, table elements,
     * ...) sits between the children and the component's host.
     */
    hydrateChildren?: boolean;
  }
}

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

const LINK_PASSING_COMPONENTS = new Set([
  'Builder:Accordion',
  'Builder: Tabs',
  'Symbol',
]);

type BuilderRegistrations = Record<
  string,
  | {
      component?: unknown;
      hydrateChildren?: boolean;
      shouldReceiveBuilderProps?: { builderLinkComponent?: boolean };
    }
  | undefined
>;

type BuilderHydratesChildren = (
  component: unknown,
  registrations: BuilderRegistrations | undefined,
  name: unknown
) => boolean;

export interface BuilderHydration {
  createOutlet: (
    injector: Injector,
    projectsContent: boolean
  ) => BuilderHydrationOutlet;
  markUnhydratableMarkup: (root: Element) => void;
  recordServerDecisions: (host: Element) => void;
  serverDecision: (host: Element) => boolean | undefined;
  forced: (host: Element) => boolean;
  projects: (component: unknown) => boolean;
  eager: (
    block: unknown,
    registrations: BuilderRegistrations | undefined,
    linkComponent: unknown
  ) => boolean;
}

let reportedSkips: WeakSet<Element> | undefined;

export const reportSkipsInDeferredBlocks = (root: Element) => {
  if (+VERSION.major < 19 || root.hasAttribute('ngSkipHydration')) return;
  const sections = root.querySelector('blocks .builder-blocks')?.children;
  for (const section of Array.from(sections ?? [])) {
    if (section.localName === 'builder-eager-block') continue;
    const skipped = section.hasAttribute('ngSkipHydration')
      ? [section]
      : Array.from(section.querySelectorAll('[ngskiphydration]'));
    for (const element of skipped) {
      let outer = element.parentElement;
      while (
        outer &&
        outer !== section &&
        !outer.hasAttribute('ngSkipHydration')
      ) {
        outer = outer.parentElement;
      }
      if (outer !== section && element !== section) continue;
      if ((reportedSkips ??= new WeakSet()).has(element)) continue;
      reportedSkips.add(element);
      const named = (subtree: Element) =>
        subtree.hasAttribute('builder-id')
          ? subtree
          : subtree.querySelector('[builder-id]');
      const own = named(element);
      const id = own?.getAttribute('builder-id') ?? '';
      const copies = Array.from(
        section.querySelectorAll('[builder-id]')
      ).filter((candidate) => candidate.getAttribute('builder-id') === id);
      console.warn(
        `[builder] <${element.localName}> ${id}${
          copies.length > 1 ? ` #${copies.indexOf(own!) + 1}` : ''
        } skips hydration inside the deferred top-level block ${
          named(section)?.getAttribute('builder-id') ?? ''
        }: until that block hydrates, its first interaction is lost.`
      );
    }
  }
};

export const BUILDER_HYDRATION = new InjectionToken<BuilderHydration>(
  'BUILDER_HYDRATION'
);

export type BuilderHydrating = () => BuilderHydration | null;

export type BuilderBlockRenderer = Type<unknown> | undefined;

export const BUILDER_HYDRATING = new InjectionToken<BuilderHydrating>(
  'BUILDER_HYDRATING'
);

export const BUILDER_REGISTERED_COMPONENTS = new InjectionToken<
  () => BuilderRegistrations | undefined
>('BUILDER_REGISTERED_COMPONENTS');

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
  wrappers,
}: {
  hydration: BuilderHydration | null;
  host: Element;
  parent: BuilderHydrating | null;
  nested: boolean | undefined;
  hydrate: boolean;
  ssrAbTest: boolean | undefined;
  content: { variations?: object } | undefined;
  wrappers: unknown[];
}) => {
  if (!hydration) return null;
  const server = hydration.serverDecision(host);
  if (server !== undefined) return server ? hydration : null;
  return (parent ? parent() : !nested) &&
    (nested || hydrate) &&
    content &&
    !ssrAbTest &&
    !Object.keys(content.variations || {}).length &&
    !wrappers.some(hydration.projects) &&
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
  hydratesChildren: BuilderHydratesChildren,
  injector: Injector,
  projectsContent: boolean
) => {
  const childInputs = createBuilderChildInputs();
  let last: { component: any; inputs: any; children: any } | undefined;
  const twin = (component: any) => twins.get(component) ?? component;
  const skipsContent =
    projectsContent && isPlatformServer(injector.get(PLATFORM_ID));
  const registrations = injector.get(BUILDER_REGISTERED_COMPONENTS, null);
  return {
    twin,
    legacy: (
      component: any,
      children: TemplateRef<any> | undefined,
      block?: { component?: { name?: string } }
    ) =>
      !!children &&
      !!component &&
      !hydratesChildren(
        twin(component),
        registrations?.(),
        block?.component?.name
      ),
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
  projector: Type<unknown>,
  hydratingChildren: unknown[] = []
): BuilderHydration => {
  const serverDecisions = new WeakMap<Element, boolean>();
  const forced = new WeakSet<Element>();
  const safe = new Set(hydratingChildren);
  const hydratesChildren: BuilderHydratesChildren = (
    component,
    registrations,
    name
  ) =>
    acceptsChildren(component) &&
    (safe.has(component) ||
      (typeof name === 'string' &&
        registrations?.[name]?.hydrateChildren === true));
  const projects = (component: unknown) =>
    !!component && !acceptsChildren(twins.get(component) ?? component);
  const eagerBlocks = new WeakMap<object, WeakMap<object, boolean>>();
  const rendersEagerly = (
    node: any,
    registrations: BuilderRegistrations | undefined,
    customLinks: boolean,
    isBlock: boolean
  ): boolean => {
    if (!node || typeof node !== 'object') return false;
    if (Array.isArray(node)) {
      return node.some((item) =>
        rendersEagerly(item, registrations, customLinks, true)
      );
    }
    const name = node.component?.name;
    const registration =
      typeof name === 'string' ? registrations?.[name] : undefined;
    const options = node.component?.options;
    const symbol = options?.symbol;
    const bindings = Object.keys(node.bindings || {});
    if (
      bindings.includes('component.name') ||
      (name === 'Symbol' &&
        (!symbol?.content ||
          Object.keys(symbol.content.variations || {}).length ||
          bindings.some(
            (key) =>
              key === 'component.options.symbol' ||
              key.startsWith('component.options.symbol.content')
          )))
    ) {
      return true;
    }
    if (
      customLinks &&
      (((isBlock || node['@type'] === '@builder.io/sdk:Element') &&
        (node.tagName === 'a' ||
          node.href ||
          node.properties?.href ||
          bindings.includes('href') ||
          bindings.includes('properties.href'))) ||
        (name === 'Core:Button'
          ? options?.link || bindings.includes('component.options.link')
          : name === 'Columns'
            ? options?.columns?.some((column: any) => column?.link) ||
              bindings.some((key) =>
                key.startsWith('component.options.columns')
              )
            : registration?.shouldReceiveBuilderProps?.builderLinkComponent &&
              !LINK_PASSING_COMPONENTS.has(name)))
    ) {
      return true;
    }
    const component = registration?.component;
    if (
      component &&
      node.children?.length &&
      !hydratesChildren(twins.get(component) ?? component, registrations, name)
    ) {
      return true;
    }
    return Object.keys(node).some((key) =>
      rendersEagerly(node[key], registrations, customLinks, false)
    );
  };
  return {
    createOutlet: (injector, projectsContent) =>
      createHydratingOutlet(
        twins,
        projector,
        forced,
        hydratesChildren,
        injector,
        projectsContent
      ),
    markUnhydratableMarkup,
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
    projects,
    eager: (block, registrations, linkComponent) => {
      if (!block || typeof block !== 'object' || !registrations) return false;
      let decided = eagerBlocks.get(registrations);
      if (!decided) eagerBlocks.set(registrations, (decided = new WeakMap()));
      let eager = decided.get(block);
      if (eager === undefined) {
        eager = rendersEagerly(block, registrations, !!linkComponent, true);
        decided.set(block, eager);
      }
      return eager;
    },
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
    legacy: (
      component: any,
      children: TemplateRef<any> | undefined,
      block?: { component?: { name?: string } }
    ) => !!hydratingOutlet()?.legacy(component, children, block),
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

@Component({
  selector: 'builder-eager-block',
  standalone: true,
  imports: [CommonModule],
  host: { ngSkipHydration: 'true' },
  template: `<ng-container
    *ngTemplateOutlet="blockTemplate(); context: { $implicit: block() }"
  ></ng-container>`,
  styles: [':host { display: contents; }'],
})
export class BuilderEagerBlock {
  blockTemplate = input<TemplateRef<any> | undefined>(undefined);
  block = input<any>(undefined);
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
}
