import type { MetadataRoute } from 'next';
import { levelList } from '@/content';

const BASE = 'https://gitsy.dev';

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: `${BASE}/`, changeFrequency: 'monthly', priority: 1 },
    { url: `${BASE}/learn`, changeFrequency: 'monthly', priority: 0.8 },
    { url: `${BASE}/docs`, changeFrequency: 'monthly', priority: 0.5 },
    ...levelList.map((l) => ({
      url: `${BASE}/learn/${l.id}`,
      changeFrequency: 'monthly' as const,
      priority: 0.6,
    })),
  ];
}
