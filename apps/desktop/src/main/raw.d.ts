/** Files bundled as text by Vite (the desktop worker's PowerShell and C# sources). */
declare module '*?raw' {
  const text: string
  export default text
}
