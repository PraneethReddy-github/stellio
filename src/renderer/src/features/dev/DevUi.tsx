import { Page } from '../../app/Page';
import s from './DevUi.module.css';
import { DataSection } from './sections/DataSection';
import { FormsSection } from './sections/FormsSection';

export default function DevUi(): React.JSX.Element {
  return (
    <Page title="UI kit">
      <div className={s.sections}>
        <FormsSection />
        <DataSection />
      </div>
    </Page>
  );
}
