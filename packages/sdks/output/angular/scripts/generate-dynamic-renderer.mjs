import fs from 'fs';
import path from 'path';

const PATH_TO_DYNAMIC_RENDERER =
  './src/components/dynamic-renderer/dynamic-renderer.ts';
const PATH_TO_HYDRATION = './src/components/hydration.ts';

if (!fs.existsSync(PATH_TO_DYNAMIC_RENDERER)) {
  console.error(
    `File ${PATH_TO_DYNAMIC_RENDERER} not found! Was the file moved or renamed?`
  );
  process.exit(1);
}

fs.copyFileSync(
  '../../overrides/angular/src/components/children-projector.ts',
  './src/components/children-projector.ts'
);

console.log('Generating dynamic-renderer.ts component...');

const htmlElements = [
  'a',
  'button',
  'div',
  'span',
  'p',
  'img',
  'input',
  'textarea',
  'select',
  'option',
  'form',
  'label',
  'ul',
  'li',
  'table',
  'tr',
  'td',
  'th',
  'thead',
  'tbody',
  'footer',
  'header',
  'nav',
  'section',
  'article',
  'aside',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'blockquote',
  'code',
  'pre',
  'figure',
  'figcaption',
  'video',
  'audio',
  'canvas',
  'iframe',
];

const voidElements = ['img', 'input'];
const rawTextElements = ['iframe', 'textarea'];

const dynamicRendererImports = [
  `import { CommonModule, NgTemplateOutlet } from '@angular/common';`,
  `import { Component, ElementRef, Injector, inject, input, viewChild, Renderer2, SimpleChanges, TemplateRef, ViewContainerRef, signal, computed } from '@angular/core';`,
  `import { isEmptyElement } from './dynamic-renderer.helpers';`,
  `import { createBuilderOutlet, injectBuilderHydrating } from '../children-projector';`,
];

const dynamicComponentTemplate = (tagName) => {
  const isVoidElement = voidElements.includes(tagName);
  return `
@Component({
  selector: 'dynamic-${tagName}, Dynamic${capitalize(tagName)}',
  template: \` <${tagName} #v ${isVoidElement ? '' : '><ng-content></ng-content>'}${isVoidElement ? '/>' : `</${tagName}>`} \`,
  standalone: true,
  styles: [':host { display: contents; }'],
})
export class Dynamic${capitalize(tagName)} {
  attributes = input.required<any>();
  actionAttributes = input<any | undefined>();
  tagName = input<string | undefined>();
  
  v = viewChild<ElementRef>('v');
  _listenerFns = new Map<string, () => void>();
  constructor(private renderer: Renderer2) {}
  setAttributes(el: any, value: any, changes?: any) {
    if (!el) return;
    const target = changes ? changes : value;
    Object.keys(target).forEach((key) => {
      if (key.startsWith('on')) {
        if (this._listenerFns.has(key)) {
          this._listenerFns.get(key)!();
        }
        this._listenerFns.set(key, this.renderer.listen(el, key.replace('on', '').toLowerCase(), target[key]));
      } else {
        this.renderer.setAttribute(el, key, target[key] ?? '');
      }
    });
  }
  ngAfterViewInit() {
    this.setAttributes(this.v()?.nativeElement, this.attributes());
  }
  ngOnChanges(changes: SimpleChanges) {
    if (changes.attributes) {
      this.setAttributes(this.v()?.nativeElement, this.attributes(), changes.attributes.currentValue);
    }
  }
  ngOnDestroy() {
    this._listenerFns.forEach(fn => fn());
  }
}

@Component({
  selector: 'dynamic-${tagName}, Dynamic${capitalize(tagName)}',
  template: \` <${tagName} #v ${isVoidElement ? '/><ng-container *ngTemplateOutlet="builderChildren()"></ng-container>' : rawTextElements.includes(tagName) ? `></${tagName}>` : `><ng-container *ngTemplateOutlet="builderChildren()"></ng-container></${tagName}>`} \`,
  standalone: true,
  imports: [NgTemplateOutlet],
  styles: [':host { display: contents; }'],
})
export class BuilderDynamic${capitalize(tagName)} extends Dynamic${capitalize(tagName)} {
  builderChildren = input<any>(undefined);
}`;
};

const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

const generateComponents = () => {
  let dynamicRendererCode = dynamicRendererImports.join('\n') + '\n\n';

  dynamicRendererCode += `
@Component({
  selector: 'dynamic-renderer, DynamicRenderer',
  template: \`
    <ng-template #tagnameTemplate><ng-content></ng-content></ng-template>
    <ng-container *ngIf="!isEmptyElement(effectiveTagName())">
      <ng-container *ngIf="tagNameIsString()">
        <ng-container
          *ngComponentOutlet="
            builderOutlet.component(mappedComponent(), tagnameTemplate);
            inputs: builderOutlet.inputs(mappedComponent(), {
              attributes: attributes(),
              actionAttributes: actionAttributes(),
              tagName: tagName()
            }, tagnameTemplate);
            content: myContent
          "
        ></ng-container>
      </ng-container>
      <ng-container *ngIf="!tagNameIsString() && dynamicTagName() !== ''">
        <ng-container
          *ngComponentOutlet="
            builderOutlet.component(effectiveTagName(), tagnameTemplate);
            inputs: builderOutlet.inputs(effectiveTagName(), {
              attributes: attributes(),
              actionAttributes: actionAttributes(),
              tagName: tagName()
            }, tagnameTemplate);
            content: myContent
          "
        ></ng-container>
      </ng-container>
       <ng-container *ngIf="!tagNameIsString() && dynamicTagName() === ''">
        <ng-container
          *ngComponentOutlet="
            builderOutlet.component(effectiveTagName(), tagnameTemplate);
            inputs: builderOutlet.inputs(effectiveTagName(), {
              attributes: attributes(),
              actionAttributes: actionAttributes(),
            }, tagnameTemplate);
            content: myContent
          "
        ></ng-container>
      </ng-container>
    </ng-container>
    <ng-container *ngIf="!!isEmptyElement(effectiveTagName())">
      <ng-container
        *ngComponentOutlet="
          effectiveTagName();
          inputs: {
            attributes: attributes(),
            actionAttributes: actionAttributes(),
          };
          content: myContent
        "
      ></ng-container>
    </ng-container>
  \`,
  standalone: true,
  imports: [CommonModule],
  styles: [':host { display: contents; }'],
})
export default class DynamicRenderer {
  isEmptyElement = isEmptyElement;
  protected readonly builderHydrating = injectBuilderHydrating();
  protected readonly builderOutlet = createBuilderOutlet(this.builderHydrating, true);

  TagName = input.required<any>();
  attributes = input.required<any>();
  actionAttributes = input.required<any>();
  tagName = signal<string>('');

  tagnameTemplateRef = viewChild<TemplateRef<any>>('tagnameTemplate');
  private _processedTagName = signal<any>(null);

  myContent?: any[][];

  tagNameIsString = computed(() => typeof this.TagName() === 'string');
  
  dynamicTagName = computed(() => this.tagName());
  
  effectiveTagName = computed(() => this._processedTagName());
  
  mappedComponent = computed(() => {
    if (this.tagNameIsString()) {
      return this.getComponentType(this.TagName());
    }
    return null;
  });

  private readonly injector = inject(Injector);

  private tagComponentMap: { [key: string]: any } = {
    ${htmlElements.map((el) => `'${el}': Dynamic${capitalize(el)}`).join(',\n    ')}
  };

  getComponentType(tagName: string): any {
    return this.tagComponentMap[tagName] || DynamicElement;
  }

  ngAfterContentInit() {
    if (this.tagNameIsString()) {
      if (this.tagComponentMap[this.TagName()]) {
        this._processedTagName.set(this.tagComponentMap[this.TagName()]);
      } else {
        this.tagName.set(this.TagName());
        this._processedTagName.set(DynamicElement);
      }
    } else {
      this._processedTagName.set(this.TagName());
    }
    if (!this.builderHydrating()) {
      this.myContent = [this.injector.get(ViewContainerRef).createEmbeddedView(this.tagnameTemplateRef()).rootNodes];
    }
  }
}
`;

  htmlElements.forEach((tagName) => {
    dynamicRendererCode += dynamicComponentTemplate(tagName) + '\n';
  });

  dynamicRendererCode += `
  @Component({
      selector: 'dynamic-element',
      template: '<ng-content></ng-content>',
      standalone: true
    })

    export class DynamicElement {
      tagName = input<string>();
      attributes = input<any>();
      actionAttributes = input<any>();
    
      private _element!: HTMLElement;
      private _listenerFns = new Map<string, () => void>();
    
      constructor(private hostRef: ElementRef, private renderer: Renderer2) {}
    
      ngOnInit() {
        if(this.tagName()){
          this._element = this.renderer.createElement(this.tagName());
          this.renderer.appendChild(this.hostRef.nativeElement, this._element);
          this.setAttributes(this._element, this.attributes());
        }
      }

      ngAfterViewInit(){
        if(this.hostRef.nativeElement.children.length > 1){
          this.renderer.appendChild(this.hostRef.nativeElement.children[1], this.hostRef.nativeElement.children[0]);
        }
      }
    
      ngOnDestroy() {
        this._listenerFns.forEach((fn) => fn());
      }
    
      setAttributes(el: any, attributes: any) {
        if (!attributes) return;
        Object.keys(attributes).forEach((key) => {
          if (key.startsWith('on')) {
            if (this._listenerFns.has(key)) {
              this._listenerFns.get(key)!();
            }
            const eventType = key.replace('on', '').toLowerCase();
            this._listenerFns.set(key, this.renderer.listen(el, eventType, attributes[key]));
          } else {
            this.renderer.setAttribute(el, key, attributes[key] ?? '');
          }
        });
      }
    }`;

  fs.writeFileSync(PATH_TO_DYNAMIC_RENDERER, dynamicRendererCode);

  const twins = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(file);
      else if (file.endsWith('.ts')) {
        for (const [, twin] of fs
          .readFileSync(file, 'utf8')
          .matchAll(/^export class (Builder\w+) extends \w+ \{/gm)) {
          const from = path
            .relative('./src/components', file)
            .replace(/\.ts$/, '');
          twins.push({ twin, from: from.startsWith('.') ? from : `./${from}` });
        }
      }
    }
  };
  walk('./src');
  const expectedTwins = [
    'BuilderFormComponent',
    'BuilderFragmentComponent',
    'BuilderImage',
    'BuilderSectionComponent',
    'BuilderInteractiveElement',
    'BuilderWrapperDiv',
    ...htmlElements.map((el) => `BuilderDynamic${capitalize(el)}`),
  ];
  const found = twins.map(({ twin }) => twin);
  if (
    found.length !== expectedTwins.length ||
    expectedTwins.some((twin) => !found.includes(twin))
  ) {
    console.error(
      `Unexpected hydrating twins: found ${found.join(', ')}; expected ${expectedTwins.join(', ')}`
    );
    process.exit(1);
  }
  const hydratingChildren = [
    'BuilderSectionComponent',
    'BuilderFragmentComponent',
  ].map((twin) => `Twin${found.indexOf(twin)}`);
  fs.writeFileSync(
    PATH_TO_HYDRATION,
    `import { makeEnvironmentProviders } from '@angular/core';
import BuilderChildrenProjector, { BUILDER_HYDRATION, createBuilderHydration } from './children-projector';
${twins.map(({ twin, from }, i) => `import { ${twin} as Twin${i} } from '${from}';`).join('\n')}

const twins = [${twins.map((_, i) => `Twin${i}`).join(', ')}];

export const provideBuilderHydration = () => {
  const twinsByComponent = new Map(twins.map((twin) => [Object.getPrototypeOf(twin), twin]));
  return makeEnvironmentProviders([
    {
      provide: BUILDER_HYDRATION,
      useValue: createBuilderHydration(twinsByComponent, BuilderChildrenProjector, [${hydratingChildren.join(', ')}]),
    },
  ]);
};
`
  );

  console.log('Dynamic renderer generated successfully!');
};

generateComponents();
