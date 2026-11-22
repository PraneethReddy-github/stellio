import { useState } from 'react';
import { Page } from '../../app/Page';
import { Inspector, SplitView, Tabs, TabsContent, TabsList, TabsTrigger } from '../../ui';
import { ApplicationSummary } from './ApplicationDetail';
import { BoardView } from './BoardView';
import { TableView } from './TableView';
import { TimelineView } from './TimelineView';
import s from './applications.module.css';

export default function ApplicationsScreen(): React.JSX.Element {
  const [view, setView] = useState('board');
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <Page title="Applications" subtitle="Every application, by lane, in a table and on a timeline." fill>
      <SplitView
        inspector={
          selected && (
            <Inspector title="Application" onClose={() => setSelected(null)}>
              <ApplicationSummary key={selected} id={selected} />
            </Inspector>
          )
        }
      >
        <Tabs value={view} onValueChange={setView} className={s.views}>
          <TabsList aria-label="View">
            <TabsTrigger value="board">Board</TabsTrigger>
            <TabsTrigger value="table">Table</TabsTrigger>
            <TabsTrigger value="timeline">Timeline</TabsTrigger>
          </TabsList>
          <TabsContent value="board" className={s.viewBody}>
            <BoardView selectedId={selected} onSelect={setSelected} />
          </TabsContent>
          <TabsContent value="table" className={s.viewBody}>
            <TableView onSelect={setSelected} />
          </TabsContent>
          <TabsContent value="timeline" className={s.viewBody}>
            <TimelineView onSelect={setSelected} />
          </TabsContent>
        </Tabs>
      </SplitView>
    </Page>
  );
}
