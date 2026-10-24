export default function Card({ as: Tag = 'div', className = '', children, ...props }) {
  return (
    <Tag className={`bg-[#111] border border-white/10 ${className}`} {...props}>
      {children}
    </Tag>
  );
}
