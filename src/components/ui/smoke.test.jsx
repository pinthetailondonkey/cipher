import Server from 'react-dom/server';
import Sheet from './Sheet';
import Dialog from './Dialog';

// Renders the real modal primitives the way a browser will mount them.
export function sheetHtml() {
  return Server.renderToString(
    <Sheet open onClose={() => {}} title="Test sheet">
      <button type="button" onClick={() => {}}>inside</button>
    </Sheet>
  );
}

export function dialogHtml() {
  return Server.renderToString(
    <Dialog open onClose={() => {}} title="Test dialog" message="confirm?">
      <button type="button" onClick={() => {}}>inside</button>
    </Dialog>
  );
}

export function smoke() {
  return `${sheetHtml()}${dialogHtml()}`;
}
