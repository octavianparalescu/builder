import { CommonModule, isPlatformServer } from '@angular/common';
import {
  Component,
  Directive,
  ElementRef,
  PLATFORM_ID,
  TemplateRef,
  ViewChild,
  ViewContainerRef,
  inject,
  input,
  reflectComponentType,
  signal,
} from '@angular/core';

const P_CLOSING_TAGS =
  'address,article,aside,blockquote,center,dd,details,dialog,dir,div,dl,dt,fieldset,figcaption,figure,footer,form,h1,h2,h3,h4,h5,h6,header,hgroup,hr,li,listing,main,menu,nav,ol,p,plaintext,pre,search,section,summary,table,ul,xmp';

const HEADING_TAGS = 'h1,h2,h3,h4,h5,h6';

const PARSER_SPECIAL_TAGS = new Set(
  'address,applet,area,article,aside,base,basefont,bgsound,blockquote,body,br,button,caption,center,col,colgroup,dd,details,dir,div,dl,dt,embed,fieldset,figcaption,figure,footer,form,frame,frameset,h1,h2,h3,h4,h5,h6,head,header,hgroup,hr,html,iframe,img,input,keygen,li,link,listing,main,marquee,menu,meta,nav,noembed,noframes,noscript,object,ol,p,param,plaintext,pre,script,section,select,source,style,summary,table,tbody,td,template,textarea,tfoot,th,thead,title,tr,track,ul,wbr,xmp'.split(
    ','
  )
);

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

const closestTag = (el: Element | null, tagName: string) => {
  while (el && el.tagName.toUpperCase() !== tagName.toUpperCase()) {
    el = el.parentElement;
  }
  return el;
};

/**
 * The browser's HTML parser re-parents nodes it cannot nest (a `<p>` holding a
 * `<div>`, nested headings/links/buttons/forms, non-table elements inside table
 * parts), so server HTML with such nesting cannot hydrate. Skips hydration for the
 * closest block that contains the damage:
 * nothing is projected into a block from outside, so its subtree can be skipped.
 */
export const markUnhydratableMarkup = (root: Element) => {
  const invalid: Element[] = [];
  for (const p of Array.from(root.querySelectorAll('p'))) {
    if (p.querySelector(P_CLOSING_TAGS)) invalid.push(p);
  }
  for (const heading of Array.from(root.querySelectorAll(HEADING_TAGS))) {
    if (heading.querySelector(HEADING_TAGS)) invalid.push(heading);
  }
  for (const inner of Array.from(
    root.querySelectorAll('a a, button button, form form')
  )) {
    const outer = closestTag(inner.parentElement, inner.tagName);
    if (outer) invalid.push(outer);
  }
  for (const part of Array.from(
    root.querySelectorAll(Object.keys(TABLE_CHILD_TAGS).join(','))
  )) {
    const allowed = TABLE_CHILD_TAGS[part.tagName.toLowerCase()];
    const table = closestTag(part, 'TABLE');
    if (
      table &&
      Array.from(part.children).some(
        (child) => !allowed.includes(child.tagName.toLowerCase())
      )
    ) {
      invalid.push(table);
    }
  }
  for (const el of invalid) {
    let boundary = el.parentElement;
    while (
      boundary &&
      boundary !== root &&
      !PARSER_SPECIAL_TAGS.has(boundary.tagName.toLowerCase())
    ) {
      boundary = boundary.parentElement;
    }
    const block =
      boundary && boundary !== root ? closestTag(boundary, 'BLOCK') : null;
    (block && root.contains(block) ? block : root).setAttribute(
      'ngSkipHydration',
      ''
    );
  }
};

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

export const builderUseProjector = (
  component: any,
  children: TemplateRef<any> | undefined
) => !!children && !!component && !acceptsChildren(component);

export const createBuilderChildInputs = () => {
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

/**
 * In-place variant of `builder-children-projector` for a component template
 * root: renders the children next to itself for projection into the sibling
 * `ngComponentOutlet`, and on the server marks the enclosing component host
 * `ngSkipHydration`, so no wrapper element is added around the target.
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
  nodes: any[][] | undefined;

  private readonly viewContainer = inject(ViewContainerRef);
  private readonly anchor = inject(ElementRef);
  private readonly isServer = isPlatformServer(inject(PLATFORM_ID));
  private rendered: TemplateRef<any> | undefined;

  ngOnChanges() {
    const children = this.children();
    if (children === this.rendered) return;
    this.rendered = children;
    this.viewContainer.clear();
    this.nodes = children
      ? [this.viewContainer.createEmbeddedView(children).rootNodes]
      : undefined;
    if (this.isServer) {
      (this.anchor.nativeElement as Node).parentElement?.setAttribute(
        'ngSkipHydration',
        ''
      );
    }
  }
}
