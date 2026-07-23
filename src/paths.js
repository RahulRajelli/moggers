/* GAP → PATH.
 *
 * The matcher already names the single most important thing missing for each
 * role (`gap` in worker/match.js). Naming a gap and then leaving the person
 * to google it is where every other tool stops; this is the cheap half of the
 * loop that actually helps — a curated first step per gap.
 *
 * ZERO AI COST, deliberately. This is a static keyword map matched in the
 * browser against text the model already produced. The daily neuron budget is
 * 8,000 and a second inference pass per match would spend it on something a
 * lookup table does exactly as well.
 *
 * The gap text is free-form model output, so matching is by keyword rather
 * than exact value. First match wins, which is why the list is ordered
 * specific-before-generic: "motion planning" must be tested before "planning",
 * and "computer vision" before "vision".
 *
 * LINK RULES, because a dead link is worse than no link:
 *   - Official documentation or a stable, well-known free course. No blogspam,
 *     no Medium, nothing behind a signup.
 *   - robosimtools tools only where they genuinely are the shortest path (URDF
 *     and CAD). Cross-promotion that wastes someone's click costs trust.
 *   - At most three per gap. This is a first step, not a syllabus.
 */

export const PATHS = [
  {
    match: /\bros\s?2?\b|\brclpy\b|\brclcpp\b|\bcolcon\b/i,
    label: "ROS 2",
    links: [
      ["Official ROS 2 tutorials", "https://docs.ros.org/en/jazzy/Tutorials.html"],
      ["URDF validator", "https://robosimtools.com/tools/urdf-validator/"],
    ],
  },
  {
    match: /\burdf\b|\bxacro\b|\brobot description\b/i,
    label: "URDF",
    links: [
      ["URDF viewer", "https://robosimtools.com/tools/urdf-viewer/"],
      ["Xacro → URDF", "https://robosimtools.com/tools/xacro-to-urdf/"],
      ["ROS 2 URDF tutorial", "https://docs.ros.org/en/jazzy/Tutorials/Intermediate/URDF/URDF-Main.html"],
    ],
  },
  {
    match: /\bslam\b|\blocali[sz]ation\b|\bmapping\b|\bodometry\b/i,
    label: "SLAM",
    links: [
      ["slam_toolbox", "https://github.com/SteveMacenski/slam_toolbox"],
      ["Nav2 documentation", "https://docs.nav2.org/"],
    ],
  },
  {
    match: /\bsensor fusion\b|\bkalman\b|\bekf\b|\bstate estimation\b/i,
    label: "State estimation",
    links: [
      ["Kalman Filter, from scratch", "https://www.kalmanfilter.net/"],
      ["Rotation converter", "https://robosimtools.com/tools/rotation-converter/"],
    ],
  },
  {
    match: /\bmotion planning\b|\btrajectory\b|\bpath planning\b|\bmoveit\b/i,
    label: "Motion planning",
    links: [
      ["MoveIt 2 tutorials", "https://moveit.picknik.ai/main/index.html"],
      ["Nav2 documentation", "https://docs.nav2.org/"],
    ],
  },
  {
    match: /\bcomputer vision\b|\bperception\b|\bopencv\b|\bpoint cloud\b|\blidar\b/i,
    label: "Perception",
    links: [
      ["OpenCV documentation", "https://docs.opencv.org/"],
      ["Open3D tutorials", "https://www.open3d.org/docs/release/tutorial/geometry/index.html"],
    ],
  },
  {
    match: /\breinforcement learning\b|\brl\b|\bsim.?to.?real\b|\bpolicy\b/i,
    label: "Reinforcement learning",
    links: [
      ["Spinning Up in Deep RL", "https://spinningup.openai.com/"],
      ["Gymnasium", "https://gymnasium.farama.org/"],
    ],
  },
  {
    match: /\bhumanoid\b|\blegged\b|\blocomotion\b|\bquadruped\b|\bwhole.?body\b/i,
    label: "Legged robots",
    links: [
      ["MuJoCo documentation", "https://mujoco.readthedocs.io/"],
      ["Isaac Lab", "https://isaac-sim.github.io/IsaacLab/"],
    ],
  },
  {
    match: /\bmanipulation\b|\bgrasp\w*\b|\barm\b|\bpick.and.place\b/i,
    label: "Manipulation",
    links: [
      ["MoveIt 2 tutorials", "https://moveit.picknik.ai/main/index.html"],
      ["Robotic manipulation (MIT)", "https://manipulation.csail.mit.edu/"],
    ],
  },
  {
    match: /\bsimulation\b|\bgazebo\b|\bisaac\b|\bmujoco\b|\bdigital twin\b/i,
    label: "Simulation",
    links: [
      ["Gazebo documentation", "https://gazebosim.org/docs"],
      ["Isaac Sim", "https://docs.isaacsim.omniverse.nvidia.com/"],
      ["MuJoCo documentation", "https://mujoco.readthedocs.io/"],
    ],
  },
  {
    match: /\bcontrol\w*\b|\bpid\b|\bmpc\b|\bstability\b/i,
    label: "Controls",
    links: [
      ["Underactuated Robotics (MIT)", "https://underactuated.csail.mit.edu/"],
      ["Control Bootcamp", "https://www.youtube.com/playlist?list=PLMrJAkhIeNNR20Mz-VpzgfQs5zrYi085m"],
    ],
  },
  {
    match: /\bembedded\b|\bfirmware\b|\brtos\b|\bmicrocontroller\b|\bstm32\b|\bcan bus\b/i,
    label: "Embedded",
    links: [
      ["FreeRTOS documentation", "https://www.freertos.org/Documentation/00-Overview"],
      ["Embedded Rust book", "https://docs.rust-embedded.org/book/"],
    ],
  },
  {
    match: /\bdeep learning\b|\bpytorch\b|\bneural\b|\btransformer\b|\bml\b|\bmachine learning\b/i,
    label: "Deep learning",
    links: [
      ["PyTorch tutorials", "https://pytorch.org/tutorials/"],
      ["Deep Learning roadmap", "https://roadmap.sh/ai-data-scientist"],
    ],
  },
  {
    match: /\bcad\b|\bsolidworks\b|\bmechanical design\b|\bdesign for manufactur\w*\b|\bgd&t\b/i,
    label: "CAD",
    links: [
      ["CAD Studio", "https://robosimtools.com/cad/"],
      ["FreeCAD documentation", "https://wiki.freecad.org/"],
    ],
  },
  {
    match: /\bstep\b|\bmesh\b|\bcollision geometry\b/i,
    label: "CAD → robot",
    links: [
      ["STEP → URDF", "https://robosimtools.com/tools/step-to-urdf/"],
    ],
  },
  {
    match: /\bardupilot\b|\bpx4\b|\bmavlink\b|\buav\b|\bdrone\b|\bflight control\b/i,
    label: "Flight stacks",
    links: [
      ["ArduPilot developer docs", "https://ardupilot.org/dev/"],
      ["Param diff", "https://robosimtools.com/tools/ardupilot-param-diff/"],
    ],
  },
  {
    /* No trailing \b after "++". `+` is a non-word character, so \b there
       demands a word character next to it and "C++ experience" — space on both
       sides — never matches. Exactly the trap ftsQuery hit with the same
       token. */
    match: /\bc\+\+|\bcpp\b/i,
    label: "C++",
    links: [
      ["C++ roadmap", "https://roadmap.sh/cpp"],
      ["learncpp.com", "https://www.learncpp.com/"],
    ],
  },
  {
    match: /\brust\b/i,
    label: "Rust",
    links: [["The Rust Book", "https://doc.rust-lang.org/book/"]],
  },
  {
    match: /\bcuda\b|\bgpu\b|\btensorrt\b/i,
    label: "GPU",
    links: [["CUDA programming guide", "https://docs.nvidia.com/cuda/cuda-c-programming-guide/"]],
  },
  {
    match: /\bkubernetes\b|\bdocker\b|\bcontainer\w*\b|\bci\/cd\b|\bdevops\b/i,
    label: "Infrastructure",
    links: [
      ["DevOps roadmap", "https://roadmap.sh/devops"],
      ["Docker documentation", "https://docs.docker.com/get-started/"],
    ],
  },
  {
    match: /\bpython\b/i,
    label: "Python",
    links: [["Python roadmap", "https://roadmap.sh/python"]],
  },
  /* Generic, and LAST. Ordering is the whole design: a gap mentioning "motion
     planning" must never fall through to this. */
  {
    match: /\bdegree\b|\bphd\b|\bmasters?\b|\bqualification\b/i,
    label: "Credentials",
    links: [
      ["Open-source robotics contributions", "https://github.com/ros2"],
    ],
  },
];

/** Find the curated path for a free-text gap, or null if nothing fits. */
export function pathFor(gap) {
  const text = String(gap || "");
  if (!text.trim()) return null;
  return PATHS.find((p) => p.match.test(text)) || null;
}
