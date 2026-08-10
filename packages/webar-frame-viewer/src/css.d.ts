// `dts: true` + `import css from './x.css'` quebra sem esta declaração.
declare module '*.css' {
  const content: string;
  export default content;
}
