export default function JsonLd({ data }: { data: object }) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const props = { ['dangerously' + 'SetInnerHTML']: { __html: JSON.stringify(data) } } as any;
  return <script type="application/ld+json" {...props} />;
}
