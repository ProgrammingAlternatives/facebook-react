const React = window.React;
const ReactDOM = window.ReactDOM;

const Rectangle = ({style, nodeRef, ...props}) => (
  <div
    {...props}
    ref={nodeRef}
    style={{border: '1px solid black', padding: 40, ...style}}
  />
);

const Overlay = ({position, ...props}) => (
  <div
    {...props}
    style={{
      width: 100,
      position: 'fixed',
      border: '1px solid blue',
      padding: 10,
      ...position,
    }}
  />
);

var portalContainer = document.createElement('div');
document.body.appendChild(portalContainer);

class MouseEventsFixtures extends React.Component {
  state = {log: [], box: null};

  log = msg => {
    this.setState(({log}) => ({
      log: log.concat(msg),
    }));
  };
  clearLog = () => {
    this.setState({log: []});
  };

  componentDidMount() {
    this.getDimensions();
  }
  componentDidUpdate() {
    this.getDimensions();
  }

  getDimensions() {
    if (!this.state.box && this.node) {
      const {left, bottom} = this.node.getBoundingClientRect();
      this.setState({
        box: {left: left + 10, top: bottom - 10},
      });
    } else if (this.state.box && !this.node) {
      this.setState({box: null});
    }
  }

  render() {
    const {box} = this.state;

    let getLogger = prefix => e => this.log(`${prefix}: ${e.type}`);
    let outerLogger = getLogger('outer');
    let innerLogger = getLogger('inner');
    let portalALogger = getLogger('portal A');
    let portalBLogger = getLogger('portal B');

    return (
      <div>
        <div className="container">
          <p>
            Mouse the mouse between the two rectangles. The console should
            only log for a given box when the mouse crosses into the box the first
            time and again when the mouse exits the
            {' '}
            <em>outer</em>
            {' '}
            bounds of each box.
          </p>
          <Rectangle onMouseEnter={outerLogger} onMouseLeave={outerLogger}>
            <Rectangle onMouseEnter={innerLogger} onMouseLeave={innerLogger} />
          </Rectangle>

          <p>
            Moving from the outer rectangle to the inner blue Portal should not trigger a
            mouseleave on the outer rectangle.
          </p>
          <Rectangle onMouseEnter={outerLogger} onMouseLeave={outerLogger}>
            <Rectangle
              onMouseEnter={innerLogger}
              onMouseLeave={innerLogger}
              nodeRef={n => (this.node = n)}>

              {box &&
                ReactDOM.unstable_createPortal(
                  <Overlay
                    position={box}
                    onMouseEnter={portalALogger}
                    onMouseLeave={portalALogger}>
                    portal A
                  </Overlay>,
                  portalContainer,
                )}
              {box &&
                ReactDOM.unstable_createPortal(
                  <Overlay
                    position={{...box, left: box.left + 100}}
                    onMouseEnter={portalBLogger}
                    onMouseLeave={portalBLogger}>
                    portal B
                  </Overlay>,
                  portalContainer,
                )}
            </Rectangle>
          </Rectangle>
        </div>

        <div className="container">
          <h4>Console: <button onClick={this.clearLog}>clear</button></h4>
          <pre className="output">
            {this.state.log.join('\n')}
          </pre>
        </div>
      </div>
    );
  }
}

module.exports = MouseEventsFixtures;
