export default function Card({ as: Tag = 'div', className = '', children, ...props }) {
  return (
    <Tag className={`border border-white/10 bg-white/5 shadow-2xl backdrop-blur-md ${className}`} {...props}>
      {children}
    </Tag>
  );
}
