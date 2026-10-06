import type { ScreenshotRun } from '@/types'

const escapeXml = (value: string) =>
  value.replace(/[<>&'"]/g, (char) => {
    const entities: Record<string, string> = {
      '<': '&lt;',
      '>': '&gt;',
      '&': '&amp;',
      "'": '&apos;',
      '"': '&quot;',
    }
    return entities[char]
  })

export const makeScreenshot = (run: ScreenshotRun, current: boolean): string => {
  const shift = current ? 10 : 0
  const accent = current ? '#165dff' : '#86909c'
  const warning = current ? '#f53f3f' : '#c9cdd4'
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="900" height="620" viewBox="0 0 900 620">
      <rect width="900" height="620" fill="#f2f3f5"/>
      <rect x="24" y="22" width="852" height="56" rx="8" fill="#ffffff" stroke="#e5e6eb"/>
      <circle cx="54" cy="50" r="10" fill="${accent}"/>
      <text x="76" y="55" font-family="Arial, sans-serif" font-size="18" font-weight="700" fill="#1d2129">${escapeXml(
        run.name,
      )}</text>
      <rect x="682" y="35" width="156" height="32" rx="6" fill="#e8f3ff"/>
      <text x="711" y="56" font-family="Arial, sans-serif" font-size="14" fill="#165dff">${
        current ? 'CURRENT' : 'BASELINE'
      }</text>
      <rect x="24" y="94" width="164" height="502" rx="8" fill="#ffffff" stroke="#e5e6eb"/>
      <rect x="43" y="116" width="118" height="34" rx="6" fill="${accent}" opacity="0.14"/>
      <rect x="52" y="128" width="76" height="9" rx="4" fill="${accent}"/>
      <rect x="43" y="168" width="105" height="9" rx="4" fill="#c9cdd4"/>
      <rect x="43" y="198" width="126" height="9" rx="4" fill="#c9cdd4"/>
      <rect x="43" y="228" width="88" height="9" rx="4" fill="#c9cdd4"/>
      <rect x="205" y="94" width="671" height="502" rx="8" fill="#ffffff" stroke="#e5e6eb"/>
      <text x="232" y="132" font-family="Arial, sans-serif" font-size="20" font-weight="700" fill="#1d2129">${escapeXml(
        run.page,
      )}</text>
      <text x="232" y="160" font-family="Arial, sans-serif" font-size="13" fill="#86909c">${escapeXml(
        run.device,
      )} · ${run.theme === 'dark' ? '深色主题' : '浅色主题'}</text>
      <rect x="${233 + shift}" y="192" width="492" height="64" rx="7" fill="#f7f8fa" stroke="#e5e6eb"/>
      <rect x="${251 + shift}" y="213" width="145" height="10" rx="5" fill="#86909c"/>
      <rect x="${251 + shift}" y="234" width="248" height="8" rx="4" fill="#c9cdd4"/>
      <rect x="${746 + shift}" y="208" width="94" height="32" rx="6" fill="${accent}"/>
      <rect x="${233 + shift}" y="276" width="607" height="128" rx="7" fill="#f7f8fa" stroke="#e5e6eb"/>
      <rect x="${252 + shift}" y="298" width="176" height="12" rx="6" fill="#4e5969"/>
      <rect x="${252 + shift}" y="328" width="540" height="8" rx="4" fill="#c9cdd4"/>
      <rect x="${252 + shift}" y="348" width="456" height="8" rx="4" fill="#c9cdd4"/>
      <rect x="${252 + shift}" y="368" width="512" height="8" rx="4" fill="#c9cdd4"/>
      <rect x="233" y="424" width="607" height="142" rx="7" fill="#f7f8fa" stroke="#e5e6eb"/>
      <rect x="252" y="446" width="132" height="11" rx="5" fill="#4e5969"/>
      <rect x="252" y="478" width="262" height="54" rx="6" fill="#ffffff" stroke="#e5e6eb"/>
      <rect x="536" y="478" width="262" height="54" rx="6" fill="#ffffff" stroke="#e5e6eb"/>
      <rect x="276" y="498" width="94" height="8" rx="4" fill="#86909c"/>
      <rect x="560" y="498" width="112" height="8" rx="4" fill="#86909c"/>
      <path d="M286 145 L382 145" stroke="${warning}" stroke-width="3" stroke-linecap="round"/>
      <path d="M286 151 L304 151" stroke="${warning}" stroke-width="3" stroke-linecap="round"/>
      <path d="M787 208 L806 208" stroke="#00b42a" stroke-width="3" stroke-linecap="round"/>
    </svg>
  `
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}
