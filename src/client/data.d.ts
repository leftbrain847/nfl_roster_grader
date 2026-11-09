// The page's data: aliased in vite.config.ts / demo/vite.config.ts (see data-source.ts).
declare module '@roster-data' {
  const data: import('../model/types.ts').ModelOutput;
  export default data;
}
