import { ImageResponse } from 'next/og';
import { getLevel, levelList } from '@/content';
import { ART_PALETTE, demoGraphSize, demoGraphSvg } from '@/site/graphArt';

// Per-level OG cards, prerendered with the level pages (Phase 8).
export const alt = 'Gitsy level';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export function generateStaticParams() {
  return levelList.map((l) => ({ levelId: l.id }));
}

export default async function LevelOg({ params }: { params: Promise<{ levelId: string }> }) {
  const { levelId } = await params;
  const level = getLevel(levelId);
  const title = level?.title ?? 'Gitsy';
  const kicker = level ? `act ${level.act}${level.par !== undefined ? ` · par ${level.par}` : ''}` : '';

  const art = demoGraphSize();
  const src = `data:image/svg+xml;base64,${Buffer.from(demoGraphSvg()).toString('base64')}`;
  const scale = Math.min(440 / art.width, 400 / art.height);

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
        <div style={{ display: 'flex', flexDirection: 'column', gap: 22, maxWidth: 640 }}>
          <div style={{ display: 'flex', color: ART_PALETTE.inkDim, fontSize: 24 }}>{kicker}</div>
          <div
            style={{
              display: 'flex',
              color: ART_PALETTE.ink,
              fontSize: 58,
              fontWeight: 600,
              lineHeight: 1.1,
            }}
          >
            {title}
          </div>
          <div style={{ display: 'flex', color: ART_PALETTE.inkDim, fontSize: 26 }}>
            gitsy · learn git by playing it
          </div>
        </div>
        <div
          style={{
            display: 'flex',
            border: `1px solid ${ART_PALETTE.rule}`,
            borderRadius: 12,
            padding: 16,
            background: ART_PALETTE.panel,
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={src} width={Math.floor(art.width * scale)} height={Math.floor(art.height * scale)} alt="" />
        </div>
      </div>
    ),
    size,
  );
}
