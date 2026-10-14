import React from 'react';
import { Construction } from 'lucide-react';

export default function Placeholder({ title, description }) {
  return (
    <>
      <header className="page-header">
        <div>
          <h1>{title}</h1>
        </div>
      </header>
      <div className="placeholder-page">
        <Construction size={28} strokeWidth={1.5} />
        <span className="placeholder-badge">Em breve</span>
        <h2>{title} ainda não está disponível</h2>
        <p>{description}</p>
      </div>
    </>
  );
}
