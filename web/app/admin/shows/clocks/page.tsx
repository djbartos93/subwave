import type { Metadata } from 'next';
import FormatClocksPanel from '../../../../components/admin/FormatClocksPanel';

export const metadata: Metadata = { title: 'Format clocks' };

export default function AdminFormatClocksPage() {
  return <FormatClocksPanel />;
}
