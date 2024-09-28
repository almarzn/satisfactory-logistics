import {
  Burger,
  Container,
  Group,
  Image,
  Tabs,
  useMantineTheme,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { UserMenu } from '../auth/UserMenu';
import classes from './MainLayout.module.css';

const user = {
  name: 'Jane Spoonfighter',
  email: 'janspoon@fighter.dev',
  image:
    'https://raw.githubusercontent.com/mantinedev/mantine/master/.demo/avatars/avatar-5.png',
};

interface MainLayoutProps {
  tabs: string[];
  activeTab: string | null;
  children?: React.ReactNode;
  onChangeTab: (tab: string | null) => void;
}

export function MainLayout(props: MainLayoutProps) {
  const theme = useMantineTheme();
  const [opened, { toggle }] = useDisclosure(false);

  return (
    <div className={classes.header}>
      <Container className={classes.mainSection} size="lg">
        <Group justify="space-between">
          <Group>
            <Image
              height={32}
              src="/images/logo/satisfactory-logistics-logo.png"
              alt="Satisfactory Logistics Planner"
            />
            {/* <IconBuildingFactory2
              stroke={2}
              style={{ width: rem(32), height: rem(32) }}
            />
            <Text size="lg" fw={700}>
              Satisfactory Logistics <i>Planner</i>
            </Text> */}
          </Group>
          <Burger opened={opened} onClick={toggle} hiddenFrom="xs" size="sm" />
          <UserMenu />
        </Group>
      </Container>
      <Container size="lg">
        <Tabs
          defaultValue="Factories"
          value={props.activeTab}
          variant="outline"
          visibleFrom="sm"
          onChange={tab => props.onChangeTab(tab)}
          classNames={{
            root: classes.tabs,
            list: classes.tabsList,
            tab: classes.tab,
          }}
        >
          <Tabs.List>
            {props.tabs.map(tab => (
              <Tabs.Tab value={tab} key={tab}>
                {tab}
              </Tabs.Tab>
            ))}
          </Tabs.List>
        </Tabs>
      </Container>
    </div>
  );
}
