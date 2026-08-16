import { ImageResponse } from 'next/og';
import { ART_PALETTE, demoGraphSize, demoGraphSvg } from '@/site/graphArt';

// Landing OG card. The graph art is the same SVG the landing page inlines
// (src/site/graphArt.ts), embedded as a data URI: satori renders <img> but
// not inline <svg>.
export const alt = 'Gitsy: learn Git by playing it';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default function LandingOg() {
  const art = demoGraphSize();
  const src = `data:image/svg+xml;base64,${Buffer.from(demoGraphSvg()).toString('base64')}`;
  const scale = Math.min(520 / art.width, 460 / art.height);
  const w = Math.floor(art.width * scale);
  const h = Math.floor(art.height * scale);

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          background: ART_PALETTE.ground,
          padding: 72,
          fontFamily: 'sans-serif',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 24, maxWidth: 600 }}>
          <div style={{ display: 'flex', color: ART_PALETTE.inkDim, fontSize: 26 }}>~/gitsy</div>
          <div
            style={{
              display: 'flex',
              color: ART_PALETTE.ink,
              fontSize: 64,
              fontWeight: 600,
              lineHeight: 1.1,
            }}
          >
            Learn Git by playing it.
          </div>
          <div style={{ display: 'flex', color: ART_PALETTE.inkDim, fontSize: 28 }}>
            A real Git engine in your browser. A real terminal. No installs.
          </div>
        </div>
        <div
          style={{
            display: 'flex',
            border: `1px solid ${ART_PALETTE.rule}`,
            borderRadius: 12,
            padding: 18,
            background: ART_PALETTE.panel,
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={src} width={w} height={h} alt="" />
        </div>
      </div>
    ),
    size,
  );
}
